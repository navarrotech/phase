//! Deciding whether to pay the aggregate combat tax imposed by UnlessPay combat
//! restrictions (Ghostly Prison, Propaganda, Sphere of Safety, Windborn Muse).
//!
//! The judgement is made twice for the same combat, and both readings must
//! agree. [`plan_attack_tax`] makes it BEFORE the declaration is submitted, so
//! the engine's completion authority knows whether to preserve taxed attackers
//! or fall back to the tax-free witness. [`CombatTaxPaymentPolicy`] and
//! [`should_pay_pending_tax`] make it again at the resulting
//! `WaitingFor::CombatTaxPayment` pause. Both route through [`tax_deltas`],
//! which is a pure function of the quote and the game state, so the AI never
//! declines a tax it just chose to incur — declining rebuilds the identical
//! declare prompt, and a disagreement between the two readings would loop
//! (CR 508.1d + CR 509.1d).
//!
//! Scoring biases toward paying when expected damage exceeds the tax cost by a
//! meaningful margin, scaled by deck archetype (aggro decks push harder).

use engine::game::combat::{
    attack_tax_is_affordable, compute_attack_tax, AttackTarget, CombatTaxPosture,
};
use engine::types::actions::GameAction;
use engine::types::game_state::{CombatTaxContext, GameState, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::player::PlayerId;

use super::context::PolicyContext;
use super::registry::{DecisionKind, PolicyId, PolicyReason, PolicyVerdict, TacticalPolicy};
use crate::features::DeckFeatures;

/// When declining the tax would remove this fraction or more of the declared
/// attackers, treat the decision as "would collapse the attack" and bias toward
/// declining unless damage potential is very high. 0.75 = if 3 of 4 attackers
/// are taxed, declining is structurally similar to declining combat.
const ATTACK_COLLAPSE_FRACTION: f64 = 0.75;

/// Base bonus applied when expected damage through exceeds the tax total.
const DAMAGE_EXCEEDS_TAX_BONUS: f64 = 0.35;

/// Base penalty applied when the tax total exceeds expected damage through.
const TAX_EXCEEDS_DAMAGE_PENALTY: f64 = -0.45;

/// Penalty for paying when the tax would consume every mana source we have —
/// leaves us unable to interact on the opponent's turn.
const TAP_OUT_PENALTY: f64 = -0.2;

/// Aggro archetypes pay the tax more aggressively — multiplier on damage-exceeds-tax.
const AGGRO_AMP: f64 = 1.4;

/// Control archetypes conserve mana for interaction — multiplier penalty on acceptance.
const CONTROL_DAMP: f64 = 0.6;

/// Reduced control dampening for blocking decisions to prevent aggressive tax decline
/// that causes blockers to disappear (issue #1541).
const BLOCKING_CONTROL_DAMP: f64 = 0.8;

/// Bonus for paying block tax to preserve valuable blockers.
const BLOCKER_VALUE_BONUS: f64 = 0.25;

/// Extra bias toward paying when declining would drop most of the declaration.
const COLLAPSE_BONUS: f64 = 0.15;

/// Scores the two `PayCombatTax` branches during lookahead rollouts.
///
/// The ROOT answer is not taken here: `deterministic_combat_choice` answers a
/// live tax prompt directly, because that answer must match the judgement that
/// authorized the declaration (see the module docs). This policy shapes the
/// value of taxed lines explored inside the search tree, where the same
/// [`tax_deltas`] contract keeps the two seams consistent.
pub struct CombatTaxPaymentPolicy;

impl TacticalPolicy for CombatTaxPaymentPolicy {
    fn id(&self) -> PolicyId {
        PolicyId::CombatTaxPayment
    }

    fn decision_kinds(&self) -> &'static [DecisionKind] {
        // CR 508.1d + CR 509.1c: the CombatTaxPayment state maps to Attackers
        // or Blockers by context (see decision_kind::classify).
        &[
            DecisionKind::DeclareAttackers,
            DecisionKind::DeclareBlockers,
        ]
    }

    fn activation(
        &self,
        _features: &DeckFeatures,
        _state: &GameState,
        _player: PlayerId,
    ) -> Option<f32> {
        // Fires reactively whenever a combat-tax decision lands on an AI seat;
        // archetype weighting lives inside verdict() so the multiplier in the
        // registry is the identity.
        // activation-constant: reactive combat-tax policy.
        Some(1.0)
    }

    fn verdict(&self, ctx: &PolicyContext<'_>) -> PolicyVerdict {
        let accept = match ctx.candidate.action {
            GameAction::PayCombatTax { accept } => accept,
            _ => {
                return PolicyVerdict::Score {
                    delta: 0.0,
                    reason: PolicyReason::new("combat_tax_na"),
                };
            }
        };

        let Some(snap) = extract_tax_state(&ctx.state.waiting_for) else {
            return PolicyVerdict::Score {
                delta: 0.0,
                reason: PolicyReason::new("combat_tax_na"),
            };
        };
        let default_features = DeckFeatures::default();
        let quote = TaxQuote {
            context: snap.context,
            total_mana_value: snap.total_mana_value,
            per_creature: &snap.per_creature,
            total_declared: total_declared_count(&ctx.state.waiting_for),
        };
        let deltas = tax_deltas(
            ctx.state,
            ctx.ai_player,
            ctx.context
                .session
                .features
                .get(&ctx.ai_player)
                .unwrap_or(&default_features),
            &quote,
        );

        let (delta, kind) = if accept {
            (deltas.accept, "combat_tax_accept")
        } else {
            (deltas.decline, "combat_tax_decline")
        };
        PolicyVerdict::Score {
            delta,
            reason: PolicyReason::new(kind)
                .with_fact("tax_mv", quote.total_mana_value as i64)
                .with_fact("expected_damage", deltas.expected_damage as i64)
                .with_fact("taxed", quote.per_creature.len() as i64)
                .with_fact("declared", quote.total_declared as i64),
        }
    }
}

/// A locked-in combat-tax quote, as both the prompt and a pre-declaration
/// proposal can describe it.
///
/// The prompt form reads it off `WaitingFor::CombatTaxPayment`; the proposal
/// form builds the same fields from `combat::compute_attack_tax` before the
/// declaration is submitted. Both feed [`tax_deltas`], so the AI's answer at the
/// prompt matches the judgement that authorized the proposal.
pub(crate) struct TaxQuote<'a> {
    pub context: CombatTaxContext,
    pub total_mana_value: u32,
    /// Per-creature breakdown — the taxed subset of the declaration.
    pub per_creature: &'a [(ObjectId, engine::types::mana::ManaCost)],
    /// Size of the whole declaration the quote was priced against.
    pub total_declared: usize,
}

/// Policy-score contributions for the two `PayCombatTax` branches of one quote.
pub(crate) struct TaxDeltas {
    pub accept: f64,
    pub decline: f64,
    /// Combined power of the taxed creatures, surfaced for decision receipts.
    pub expected_damage: i32,
}

impl TaxDeltas {
    /// True when paying scores strictly better than declining.
    ///
    /// This is the single authority for "is this tax worth paying". Because it
    /// is a pure function of the quote and the game state, the declare step and
    /// the payment prompt reach the same answer, which is what makes a taxed
    /// AI declaration terminate (CR 508.1d — declining rebuilds the identical
    /// declare prompt).
    pub fn prefers_paying(&self) -> bool {
        self.accept > self.decline
    }
}

/// Score the accept and decline branches of one combat-tax quote.
///
/// Biases toward paying when the taxed creatures' damage exceeds the quote,
/// scaled by deck archetype, and away from it when the payment would tap the
/// seat out of interaction.
pub(crate) fn tax_deltas(
    state: &GameState,
    player: PlayerId,
    features: &DeckFeatures,
    quote: &TaxQuote<'_>,
) -> TaxDeltas {
    // Damage potential: sum of powers of the taxed creatures.
    let expected_damage: i32 = quote
        .per_creature
        .iter()
        .map(|(id, _)| state.objects.get(id).and_then(|obj| obj.power).unwrap_or(0))
        .sum();
    let tax = quote.total_mana_value as i32;

    let collapse_fraction = if quote.total_declared > 0 {
        quote.per_creature.len() as f64 / quote.total_declared as f64
    } else {
        0.0
    };

    // Archetype modifier — aggro amplifies, control dampens.
    let archetype_mod = archetype_multiplier(features, quote.context.clone());

    let base_delta = if expected_damage > tax {
        DAMAGE_EXCEEDS_TAX_BONUS * archetype_mod
    } else if expected_damage < tax {
        TAX_EXCEEDS_DAMAGE_PENALTY / archetype_mod.max(0.01)
    } else {
        0.0
    };

    // Mana availability penalty — if we'd tap out and lose interaction.
    let available = count_untapped_mana_sources(state, player);
    let tap_out_penalty = if available > 0 && available.saturating_sub(quote.total_mana_value) == 0
    {
        TAP_OUT_PENALTY
    } else {
        0.0
    };

    // If declining would collapse the declaration (> fraction taxed), treat that
    // as "might as well pay" and add a modest additional bonus.
    let collapse_bonus = if collapse_fraction >= ATTACK_COLLAPSE_FRACTION && expected_damage > 0 {
        COLLAPSE_BONUS
    } else {
        0.0
    };

    // Blocker value bonus: when blocking, add bonus for paying tax to preserve
    // valuable blockers. This addresses issue #1541 where blockers disappear
    // due to aggressive tax decline.
    let blocker_value_bonus = if matches!(quote.context, CombatTaxContext::Blocking) {
        BLOCKER_VALUE_BONUS
    } else {
        0.0
    };

    TaxDeltas {
        accept: base_delta + tap_out_penalty + collapse_bonus + blocker_value_bonus,
        // Decline: sign-flipped base_delta (declining is the opposite decision).
        decline: -base_delta,
        expected_damage,
    }
}

/// CombatTaxPayment summary extracted from the `WaitingFor` for scoring.
struct TaxSnapshot {
    context: CombatTaxContext,
    total_mana_value: u32,
    per_creature: Vec<(ObjectId, engine::types::mana::ManaCost)>,
}

/// Extract the CombatTaxPayment waiting state's context, total mana value, and
/// per-creature tax breakdown.
fn extract_tax_state(waiting_for: &WaitingFor) -> Option<TaxSnapshot> {
    if let WaitingFor::CombatTaxPayment {
        context,
        total_cost,
        per_creature,
        ..
    } = waiting_for
    {
        Some(TaxSnapshot {
            context: context.clone(),
            total_mana_value: total_cost.mana_value(),
            per_creature: per_creature.clone(),
        })
    } else {
        None
    }
}

/// Size of the parent declaration (attackers or blockers) from the state — used
/// to compute what fraction of the declaration is taxed.
fn total_declared_count(waiting_for: &WaitingFor) -> usize {
    match waiting_for {
        WaitingFor::CombatTaxPayment { pending, .. } => match pending {
            engine::types::game_state::CombatTaxPending::Attack { attacks, .. } => attacks.len(),
            engine::types::game_state::CombatTaxPending::Block { assignments } => assignments.len(),
        },
        _ => 0,
    }
}

/// Count untapped mana sources (lands + mana rocks) the AI controls. Mirrors
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
                .any(|t| matches!(t, engine::types::card_type::CoreType::Land))
                || obj.abilities.iter().any(|a| {
                    matches!(a.kind, engine::types::ability::AbilityKind::Activated)
                        && matches!(*a.effect, engine::types::ability::Effect::Mana { .. })
                })
        })
        .count() as u32
}

/// CR 109.5 + deck archetype: aggro decks push harder on paying the attack tax
/// (so their attack doesn't collapse); control decks conserve mana for
/// interaction (so they decline the block tax more often).
fn archetype_multiplier(features: &DeckFeatures, context: CombatTaxContext) -> f64 {
    let aggro = features.aggro_pressure.commitment.clamp(0.0, 1.0) as f64;
    let control = features.control.commitment.clamp(0.0, 1.0) as f64;

    match context {
        // Attack side: aggro wants the attack to continue → amplify accept bias.
        CombatTaxContext::Attacking => {
            1.0 + (AGGRO_AMP - 1.0) * aggro - (1.0 - CONTROL_DAMP) * control
        }
        // Block side: reduced control dampening to prevent aggressive tax decline
        // that causes blockers to disappear (issue #1541). Control decks still
        // conserve mana, but the penalty is less severe to preserve valuable blockers.
        CombatTaxContext::Blocking => 1.0 - (1.0 - BLOCKING_CONTROL_DAMP) * control,
    }
}

/// Choose the attack declaration and tax posture the AI is prepared to honour.
///
/// Returns the (possibly trimmed) proposal to submit and the posture to complete
/// it under. A tax is per attacker (CR 508.1h), so an alpha strike the AI cannot
/// afford in full is not abandoned: the weakest taxed attacker is dropped and the
/// smaller strike re-priced, until one is both affordable and worth its price.
/// An empty result hands the engine's tax-free witness the final say, which is
/// also what honours any must-attack requirement the trimming walked past.
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
            total_mana_value: total_cost.mana_value(),
            per_creature: &per_creature,
            total_declared: kept.len(),
        };
        if attack_tax_is_affordable(state, &kept)
            && tax_deltas(state, player, features, &quote).prefers_paying()
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

/// Answer a live `WaitingFor::CombatTaxPayment` pause: pay, or decline?
///
/// Reads the quote the engine locked in and re-runs [`tax_deltas`] against it.
/// On the attack side the AI only reaches this prompt by having planned an
/// `Accept` posture for this same declaration, so this returns `true` and the
/// declaration commits. A state that carries no tax prompt declines, which is
/// the safe answer for a prompt this seat did not author.
pub(crate) fn should_pay_pending_tax(
    state: &GameState,
    player: PlayerId,
    features: &DeckFeatures,
) -> bool {
    let Some(snap) = extract_tax_state(&state.waiting_for) else {
        tracing::debug!(
            "should_pay_pending_tax called outside a CombatTaxPayment pause; declining"
        );
        return false;
    };
    let quote = TaxQuote {
        context: snap.context,
        total_mana_value: snap.total_mana_value,
        per_creature: &snap.per_creature,
        total_declared: total_declared_count(&state.waiting_for),
    };
    tax_deltas(state, player, features, &quote).prefers_paying()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::DeckFeatures;
    use engine::types::game_state::{CombatTaxPending, WaitingFor};
    use engine::types::identifiers::{ObjectId, ObjectIncarnationRef};
    use engine::types::mana::ManaCost;
    use engine::types::player::PlayerId;

    fn features_aggro() -> DeckFeatures {
        let mut f = DeckFeatures::default();
        f.aggro_pressure.commitment = 0.9;
        f
    }

    fn features_control() -> DeckFeatures {
        let mut f = DeckFeatures::default();
        f.control.commitment = 0.9;
        f
    }

    #[test]
    fn aggro_amplifies_accept_when_damage_exceeds_tax() {
        let aggro = features_aggro();
        let control = features_control();
        let amp_aggro = archetype_multiplier(&aggro, CombatTaxContext::Attacking);
        let amp_control = archetype_multiplier(&control, CombatTaxContext::Attacking);
        assert!(
            amp_aggro > amp_control,
            "aggro amplifier {amp_aggro} should exceed control {amp_control}"
        );
    }

    #[test]
    fn total_declared_count_matches_pending_attack() {
        let waiting = WaitingFor::CombatTaxPayment {
            player: PlayerId(0),
            context: CombatTaxContext::Attacking,
            total_cost: ManaCost::generic(4),
            per_creature: vec![(ObjectId(1), ManaCost::generic(2))],
            pending: CombatTaxPending::Attack {
                // `total_declared_count` reads only `.len()`, so the incarnation
                // value is arbitrary here (0 = fresh-object epoch).
                attacks: vec![
                    (
                        ObjectIncarnationRef::of(ObjectId(1), 0),
                        engine::game::combat::AttackTarget::Player(PlayerId(1)),
                    ),
                    (
                        ObjectIncarnationRef::of(ObjectId(2), 0),
                        engine::game::combat::AttackTarget::Player(PlayerId(1)),
                    ),
                ],
                bands: vec![],
            },
        };
        assert_eq!(total_declared_count(&waiting), 2);
    }

    #[test]
    fn extract_tax_state_returns_none_for_non_combat_tax_state() {
        let waiting = WaitingFor::Priority {
            player: PlayerId(0),
        };
        assert!(extract_tax_state(&waiting).is_none());
    }
}
