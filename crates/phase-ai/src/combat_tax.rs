//! Deciding whether to pay the aggregate combat tax imposed by UnlessPay combat
//! restrictions (Propaganda, Ghostly Prison, Sphere of Safety, Windborn Muse,
//! Norn's Annex) and their block-side twins.
//!
//! CR 508.1d + CR 509.1c: a player is never required to pay a combat tax, so the
//! engine's declaration-completion authority has to be told whether the
//! declaring seat intends to. [`plan_attack_tax`] and [`plan_block_tax`] make that
//! call BEFORE the declaration is submitted and return a
//! [`CombatTaxPosture`]: `Accept` keeps the taxed creatures, `Refuse` lets the
//! engine substitute its tax-free witness.
//!
//! The payment prompt that follows an `Accept` is answered by the engine-owned
//! `combat::pending_combat_tax_is_affordable`, not by a second judgement here.
//! Declining that prompt rebuilds the identical declare prompt, so an answer that
//! could disagree with the posture which opened it would loop. Keeping the
//! judgement in exactly one place is what makes the round trip terminate.

use engine::game::combat::{
    attack_tax_is_affordable, block_tax_is_affordable, compute_attack_tax, compute_block_tax,
    AttackTarget, CombatTaxPosture,
};
use engine::types::game_state::{CombatTaxContext, GameState};
use engine::types::identifiers::ObjectId;
use engine::types::mana::ManaCost;
use engine::types::player::PlayerId;

use crate::features::DeckFeatures;

/// When declining the tax would remove this fraction or more of the declared
/// creatures, treat the decision as "would collapse the declaration" and add a
/// modest bias toward paying. 0.75 = if 3 of 4 attackers are taxed, declining is
/// structurally similar to declining combat.
const DECLARATION_COLLAPSE_FRACTION: f64 = 0.75;

/// Base bonus applied when expected damage through exceeds the tax total.
const DAMAGE_EXCEEDS_TAX_BONUS: f64 = 0.35;

/// Base penalty applied when the tax total exceeds expected damage through.
const TAX_EXCEEDS_DAMAGE_PENALTY: f64 = -0.45;

/// Penalty for paying when the tax would consume every mana source we have,
/// leaving us unable to interact on the opponent's turn.
const TAP_OUT_PENALTY: f64 = -0.2;

/// Aggro archetypes pay the attack tax more aggressively.
const AGGRO_AMP: f64 = 1.4;

/// Control archetypes conserve mana for interaction.
const CONTROL_DAMP: f64 = 0.6;

/// Reduced control dampening for blocking decisions, so a control seat does not
/// shed its blockers to a tax it can comfortably pay (issue #1541).
const BLOCKING_CONTROL_DAMP: f64 = 0.8;

/// Bonus for paying a block tax to keep valuable blockers.
const BLOCKER_VALUE_BONUS: f64 = 0.25;

/// Extra bias toward paying when declining would drop most of the declaration.
const COLLAPSE_BONUS: f64 = 0.15;

/// Choose the attack declaration and tax posture the AI is prepared to honour.
///
/// Returns the (possibly trimmed) proposal to submit and the posture to complete
/// it under. A tax is charged per attacker (CR 508.1h), so an alpha strike the AI
/// cannot afford in full is not abandoned: the weakest taxed attacker is dropped
/// and the smaller strike re-priced, until one is both worth its price and
/// affordable. An empty result hands the engine's tax-free witness the final say,
/// which is also what honours any must-attack requirement the trimming walked past.
pub(crate) fn plan_attack_tax(
    state: &GameState,
    player: PlayerId,
    features: &DeckFeatures,
    attacks: &[(ObjectId, AttackTarget)],
) -> (Vec<(ObjectId, AttackTarget)>, CombatTaxPosture) {
    let mut kept = attacks.to_vec();
    while !kept.is_empty() {
        // No quote left means trimming removed every taxed attacker, so what
        // remains attacks for free.
        let Some((total_cost, per_creature)) = compute_attack_tax(state, &kept) else {
            return (kept, CombatTaxPosture::Refuse);
        };
        let quote = TaxQuote {
            context: CombatTaxContext::Attacking,
            total_cost: &total_cost,
            per_creature: &per_creature,
            total_declared: kept.len(),
        };
        // The judgement is cheap; the affordability probe clones the state to
        // simulate auto-tapping, so it only runs for a strike worth paying for.
        if is_worth_paying(state, player, features, &quote)
            && attack_tax_is_affordable(state, &kept)
        {
            return (kept, CombatTaxPosture::Accept);
        }

        let Some(weakest) = per_creature
            .iter()
            .map(|(id, _)| *id)
            // Tie-broken by id so the trim is deterministic across runs.
            .min_by_key(|id| (state.objects.get(id).and_then(|obj| obj.power), id.0))
        else {
            break;
        };
        kept.retain(|(id, _)| *id != weakest);
    }

    (Vec::new(), CombatTaxPosture::Refuse)
}

/// Choose the posture to complete a blocker proposal under.
///
/// CR 509.1d: `Accept` only when paying is worth it and the defending seat can
/// cover the quote, so the completion never opens a payment prompt this seat
/// would then be unable to answer with a payment. Blocks are not trimmed: an
/// unaccepted proposal falls back to the engine's tax-free witness whole.
pub(crate) fn plan_block_tax(
    state: &GameState,
    player: PlayerId,
    features: &DeckFeatures,
    assignments: &[(ObjectId, ObjectId)],
) -> CombatTaxPosture {
    let Some((total_cost, per_creature)) = compute_block_tax(state, assignments) else {
        return CombatTaxPosture::Refuse;
    };
    let quote = TaxQuote {
        context: CombatTaxContext::Blocking,
        total_cost: &total_cost,
        per_creature: &per_creature,
        total_declared: assignments.len(),
    };
    if is_worth_paying(state, player, features, &quote)
        && block_tax_is_affordable(state, player, assignments)
    {
        return CombatTaxPosture::Accept;
    }
    CombatTaxPosture::Refuse
}

/// A combat-tax quote for one proposed declaration.
struct TaxQuote<'a> {
    context: CombatTaxContext,
    total_cost: &'a ManaCost,
    /// Per-creature breakdown: the taxed subset of the declaration.
    per_creature: &'a [(ObjectId, ManaCost)],
    /// Size of the whole declaration the quote was priced against.
    total_declared: usize,
}

/// Does paying this quote beat letting its creatures drop out of combat?
///
/// Paying earns the damage bias (scaled by deck archetype), minus a penalty for
/// tapping out of interaction, plus bonuses for keeping a declaration from
/// collapsing and for keeping blockers. Declining earns the opposite of the
/// damage bias.
fn is_worth_paying(
    state: &GameState,
    player: PlayerId,
    features: &DeckFeatures,
    quote: &TaxQuote<'_>,
) -> bool {
    let tax_mana_value = quote.total_cost.mana_value();

    // Damage potential: sum of powers of the taxed creatures.
    let expected_damage: i32 = quote
        .per_creature
        .iter()
        .map(|(id, _)| state.objects.get(id).and_then(|obj| obj.power).unwrap_or(0))
        .sum();
    let tax = tax_mana_value as i32;

    let archetype_mod = archetype_multiplier(features, quote.context.clone());
    let damage_bias = if expected_damage > tax {
        DAMAGE_EXCEEDS_TAX_BONUS * archetype_mod
    } else if expected_damage < tax {
        TAX_EXCEEDS_DAMAGE_PENALTY / archetype_mod.max(0.01)
    } else {
        0.0
    };

    let available = count_untapped_mana_sources(state, player);
    let tap_out_penalty = if available > 0 && available.saturating_sub(tax_mana_value) == 0 {
        TAP_OUT_PENALTY
    } else {
        0.0
    };

    let collapse_fraction = if quote.total_declared > 0 {
        quote.per_creature.len() as f64 / quote.total_declared as f64
    } else {
        0.0
    };
    let collapse_bonus =
        if collapse_fraction >= DECLARATION_COLLAPSE_FRACTION && expected_damage > 0 {
            COLLAPSE_BONUS
        } else {
            0.0
        };

    let blocker_value_bonus = match quote.context {
        CombatTaxContext::Blocking => BLOCKER_VALUE_BONUS,
        CombatTaxContext::Attacking => 0.0,
    };

    let pay_value = damage_bias + tap_out_penalty + collapse_bonus + blocker_value_bonus;
    let decline_value = -damage_bias;
    pay_value > decline_value
}

/// Count untapped mana sources (lands + mana rocks) the seat controls. Mirrors
/// the helper used by `HoldManaUpForInteractionPolicy`.
fn count_untapped_mana_sources(state: &GameState, player: PlayerId) -> u32 {
    state
        .battlefield
        .iter()
        .filter(|&&id| {
            let Some(obj) = state.objects.get(&id) else {
                return false;
            };
            if obj.controller != player || obj.tapped {
                return false;
            }
            // Heuristic: lands + artifacts with a mana ability produce mana.
            obj.card_types
                .core_types
                .iter()
                .any(|core_type| matches!(core_type, engine::types::card_type::CoreType::Land))
                || obj.abilities.iter().any(|ability| {
                    matches!(ability.kind, engine::types::ability::AbilityKind::Activated)
                        && matches!(*ability.effect, engine::types::ability::Effect::Mana { .. })
                })
        })
        .count() as u32
}

/// Deck archetype weighting: aggro decks push harder on paying the attack tax (so
/// their attack doesn't collapse); control decks conserve mana for interaction.
fn archetype_multiplier(features: &DeckFeatures, context: CombatTaxContext) -> f64 {
    let aggro = features.aggro_pressure.commitment.clamp(0.0, 1.0) as f64;
    let control = features.control.commitment.clamp(0.0, 1.0) as f64;

    match context {
        CombatTaxContext::Attacking => {
            1.0 + (AGGRO_AMP - 1.0) * aggro - (1.0 - CONTROL_DAMP) * control
        }
        // Reduced control dampening so a control seat keeps its blockers
        // (issue #1541).
        CombatTaxContext::Blocking => 1.0 - (1.0 - BLOCKING_CONTROL_DAMP) * control,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn features_with(aggro: f32, control: f32) -> DeckFeatures {
        let mut features = DeckFeatures::default();
        features.aggro_pressure.commitment = aggro;
        features.control.commitment = control;
        features
    }

    #[test]
    fn aggro_amplifies_the_attack_tax_bias_over_control() {
        let aggro = archetype_multiplier(&features_with(0.9, 0.0), CombatTaxContext::Attacking);
        let control = archetype_multiplier(&features_with(0.0, 0.9), CombatTaxContext::Attacking);
        assert!(
            aggro > control,
            "aggro amplifier {aggro} should exceed control {control}"
        );
    }

    /// Issue #1541: blocking dampens control less than attacking does, so a
    /// control seat is more willing to keep its blockers than to press an attack.
    #[test]
    fn control_is_damped_less_when_blocking_than_when_attacking() {
        let control = features_with(0.0, 0.9);
        let blocking = archetype_multiplier(&control, CombatTaxContext::Blocking);
        let attacking = archetype_multiplier(&control, CombatTaxContext::Attacking);
        assert!(
            blocking > attacking,
            "blocking multiplier {blocking} should exceed attacking {attacking}"
        );
    }
}
