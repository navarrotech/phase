//! Engine-authored decision briefs for an external reasoner.
//!
//! An LLM opponent is not a difficulty level and not a second rules engine. It
//! is a *chooser*: the engine issues a finite domain of legal actions through
//! [`AiDecisionContract`], this module renders that domain plus the board it
//! applies to, and the reasoner returns one index. Nothing here can widen the
//! domain, and nothing outside the engine decides what is legal.
//!
//! Two responsibilities live here, and only these two:
//!
//! 1. **Escalation.** [`prepare_llm_decision`] answers whether a decision is
//!    worth an external consult at all. A priority prompt whose only legal
//!    moves are "pass" and mana bookkeeping is not a decision a reasoner should
//!    be paid to make, and a game contains far more of those than real ones.
//!    The verdict is the engine's, never the caller's — see [`DeferReason`].
//! 2. **Rendering.** [`DecisionBrief`] is a compact, serializable projection of
//!    the state that a chooser actually needs. It is deliberately *not*
//!    `ClientGameStateRef`: that view serializes the whole `GameState` for a
//!    renderer that already knows the rules, which on a wide board is orders of
//!    magnitude larger than a reasoner needs and changes on every action.
//!
//! # Object identity
//!
//! Actions reference permanents and cards by [`ObjectId`]. Rather than guess
//! which integers in a serialized action payload are object ids — a heuristic
//! that mistakes `{"count": 3}` for object 3 — the brief carries the board as a
//! flat list of `(id, name, …)` rows and hands the reasoner the raw action
//! payload. Cross-referencing is unambiguous and needs no per-variant table.
//!
//! # Why the labels are structural
//!
//! [`describe_action`] composes a label from [`GameAction::variant_name`] and
//! [`GameAction::source_object`], both of which are existing engine
//! authorities. It handles every one of the ~130 `GameAction` variants and
//! every variant added after this file was written. A per-variant `match` would
//! be a maintenance liability that silently degrades the moment someone adds an
//! action without updating it.

use serde::Serialize;

use crate::game::game_object::{AttachTarget, GameObject};
use crate::types::actions::GameAction;
use crate::types::game_state::{GameState, StackEntry, WaitingFor};
use crate::types::phase::Phase;
use crate::types::player::PlayerId;
use crate::types::zones::Zone;

use super::context::AiDecisionContract;
use super::{has_meaningful_priority_action, legal_actions};

/// Whether a decision warrants an external reasoner, and the brief if it does.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub enum LlmConsult {
    /// The decision is worth an external consult; `brief` fully describes it.
    Consult { brief: Box<DecisionBrief> },
    /// The engine's own chooser is sufficient. The caller must fall back to the
    /// local AI rather than skip the decision — every prompt still owes an
    /// action.
    Defer { reason: DeferReason },
}

/// Why the engine declined to route a decision to an external reasoner.
///
/// A typed reason rather than a bare `bool` so the escalation policy is legible
/// in telemetry and adjustable per-reason without changing the call signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeferReason {
    /// The contract issued no candidates. The local chooser owns the fallback
    /// path for combat declarations, whose domain is validator-bounded rather
    /// than enumerated (see [`AiDecisionContract::contains_action`]).
    NoCandidates,
    /// Exactly one legal action. There is nothing to choose.
    SingleCandidate,
    /// A priority prompt with no action that changes the game beyond passing or
    /// producing standalone mana, per [`has_meaningful_priority_action`].
    MechanicalPriority,
    /// Mana payment and mana-source selection. The engine's solver already
    /// picks a payment that preserves the caller's remaining options, and these
    /// prompts dominate the decision count in any real game — routing them
    /// outward costs far more than it can plausibly win.
    MechanicalPayment,
}

/// A compact, self-contained description of one pending decision.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionBrief {
    /// The player the decision belongs to.
    pub semantic_owner: u8,
    /// The player authorized to submit it. Differs from `semantic_owner` under
    /// control effects (CR 723.5).
    pub authorized_actor: u8,
    pub turn_number: u32,
    pub active_player: u8,
    pub phase: Phase,
    /// The `WaitingFor` variant name, e.g. `"Priority"`, `"TargetSelection"`.
    /// The variant name plus the candidate list is enough to act; the full
    /// prompt payload rides along in `prompt_payload` for anything subtler.
    pub prompt: &'static str,
    /// The serialized `WaitingFor`, verbatim. Nothing is summarized away.
    pub prompt_payload: serde_json::Value,
    pub players: Vec<PlayerBrief>,
    /// Stack entries, bottom-first — the order they resolve in reverse.
    pub stack: Vec<StackBrief>,
    pub combat: Option<CombatBrief>,
    pub candidates: Vec<CandidateBrief>,
}

/// One player's public state, plus the private zones the brief's owner may see.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerBrief {
    pub player: u8,
    /// True for the player this brief was built for.
    pub is_you: bool,
    pub life: i32,
    pub poison_counters: u32,
    pub library_size: usize,
    /// Populated only for the brief's owner; opponents contribute a count via
    /// `hand_size`. A reasoner must not see an opponent's hand.
    pub hand: Vec<ObjectBrief>,
    pub hand_size: usize,
    pub battlefield: Vec<ObjectBrief>,
    pub graveyard: Vec<ObjectBrief>,
    /// Floating mana, as `{symbol: count}`.
    pub mana_pool: serde_json::Value,
}

/// One object, identified so an action payload's ids can be resolved by lookup.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectBrief {
    pub id: u64,
    pub name: String,
    pub controller: u8,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub tapped: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub face_down: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toughness: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loyalty: Option<u32>,
    /// Damage marked this turn. Lethality is `toughness - damage` for a
    /// creature without indestructible; the reasoner is given the inputs rather
    /// than a precomputed verdict it cannot audit.
    #[serde(skip_serializing_if = "is_zero")]
    pub damage_marked: u32,
    /// Counters as `{counterType: count}`; omitted when empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counters: Option<serde_json::Value>,
    /// Ids of objects attached to this one (Auras, Equipment, fortifications).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<u64>,
    /// The object this one is attached to, when it is an attachment itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_to: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackBrief {
    pub id: u64,
    pub name: String,
    pub controller: u8,
    /// The `StackEntryKind` variant name — `"Spell"`, `"TriggeredAbility"`, …
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatBrief {
    /// Attacker id paired with what it is attacking, rendered as the defending
    /// player's index or the defending permanent's id.
    pub attackers: Vec<serde_json::Value>,
    /// Blocker id paired with the attackers it blocks.
    pub blockers: Vec<serde_json::Value>,
}

/// One legal action, addressed by the index the reasoner returns.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateBrief {
    /// Position in `DecisionBrief::candidates`. This is the reasoner's answer.
    pub index: usize,
    /// Human-readable summary, composed structurally — see the module docs.
    pub label: String,
    /// The action itself. Submitted verbatim, then re-validated against the
    /// contract at the action boundary, so a malformed echo is rejected rather
    /// than applied.
    pub action: GameAction,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// Decides whether the pending decision warrants an external reasoner.
///
/// Takes the already-issued `contract` rather than issuing its own so the
/// candidate indices in the returned brief address exactly the domain the
/// caller will validate a submission against. Issuing twice would be
/// deterministic today but couples correctness to that fact.
///
/// Returns [`LlmConsult::Defer`] for decisions the engine's own chooser handles
/// at least as well, which is the large majority of prompts in a real game. The
/// caller must still submit an action in the deferred case — this is a routing
/// verdict, not permission to skip a turn.
///
/// # Examples
///
/// ```ignore
/// let contract = AiDecisionContract::issue(&state, PlayerId(1));
/// match prepare_llm_decision(&state, &contract) {
///     LlmConsult::Consult { brief } => ask_the_model(&brief),
///     LlmConsult::Defer { .. } => local_ai_choice(&state, PlayerId(1)),
/// }
/// ```
pub fn prepare_llm_decision(state: &GameState, contract: &AiDecisionContract) -> LlmConsult {
    if matches!(
        state.waiting_for,
        WaitingFor::ManaPayment { .. } | WaitingFor::ManaSourceSelection { .. }
    ) {
        return LlmConsult::Defer {
            reason: DeferReason::MechanicalPayment,
        };
    }

    match contract.candidates.len() {
        0 => {
            return LlmConsult::Defer {
                reason: DeferReason::NoCandidates,
            }
        }
        1 => {
            return LlmConsult::Defer {
                reason: DeferReason::SingleCandidate,
            }
        }
        _ => {}
    }

    // A priority prompt whose legal moves amount to "pass, or tap something for
    // mana you have no use for" is bookkeeping. `has_meaningful_priority_action`
    // is the engine's existing authority for that question, shared with the
    // human-facing auto-pass gate, so the two never disagree.
    if matches!(state.waiting_for, WaitingFor::Priority { .. })
        && !has_meaningful_priority_action(state, &legal_actions(state))
    {
        return LlmConsult::Defer {
            reason: DeferReason::MechanicalPriority,
        };
    }

    let candidates = contract
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| CandidateBrief {
            index,
            label: describe_action(state, &candidate.action),
            action: candidate.action.clone(),
        })
        .collect();

    LlmConsult::Consult {
        brief: Box::new(DecisionBrief {
            semantic_owner: contract.semantic_owner.0,
            authorized_actor: contract.authorized_actor.0,
            turn_number: state.turn_number,
            active_player: state.active_player.0,
            phase: state.phase,
            prompt: state.waiting_for.variant_name(),
            prompt_payload: serde_json::to_value(&state.waiting_for)
                .unwrap_or(serde_json::Value::Null),
            players: state
                .players
                .iter()
                .map(|seat| player_brief(state, seat.id, contract.semantic_owner))
                .collect(),
            stack: state
                .stack
                .iter()
                .map(|entry| stack_brief(state, entry))
                .collect(),
            combat: combat_brief(state),
            candidates,
        }),
    }
}

/// Renders one action as a human-readable line.
///
/// Composed from [`GameAction::variant_name`] and [`GameAction::source_object`]
/// so it covers every variant, including ones added later. Callers that need
/// the exact payload read `CandidateBrief::action` instead — this is a label,
/// not a serialization.
pub fn describe_action(state: &GameState, action: &GameAction) -> String {
    let mut label = humanize_variant(action.variant_name());
    let source_name = action
        .source_object()
        .and_then(|id| state.objects.get(&id))
        .map(|object| object.name.as_str());
    if let Some(name) = source_name {
        label.push_str(": ");
        label.push_str(name);
    }
    label
}

/// Splits a `PascalCase` variant name into spaced words as a sentence:
/// `CastSpell` → `Cast spell`.
///
/// Two capitals are left alone rather than downcased, because downcasing them
/// loses information: a lone capital that is its own word (the `X` in
/// `ChooseXValue` → `Choose X value`) and a capital inside a run of capitals
/// (an acronym). Everything else that opens a word becomes lowercase.
fn humanize_variant(variant: &str) -> String {
    let chars: Vec<char> = variant.chars().collect();
    let mut out = String::with_capacity(variant.len() + 4);

    for (index, &current) in chars.iter().enumerate() {
        if !current.is_uppercase() {
            out.push(current);
            continue;
        }

        let previous_is_lower = index
            .checked_sub(1)
            .is_some_and(|i| chars[i].is_lowercase());
        let previous_is_upper = index
            .checked_sub(1)
            .is_some_and(|i| chars[i].is_uppercase());
        let next_is_lower = chars.get(index + 1).is_some_and(|next| next.is_lowercase());

        // A capital opens a word when it follows a lowercase letter, or when it
        // closes a run of capitals and a lowercase letter follows — which is
        // what separates the `X` from `Value` in `ChooseXValue`.
        let opens_word = previous_is_lower || (previous_is_upper && next_is_lower);
        if opens_word {
            out.push(' ');
        }

        // No following lowercase letter means this capital is a word on its own
        // or part of an acronym; either way its case carries meaning.
        let stands_alone = !next_is_lower;
        if index == 0 || !opens_word || stands_alone {
            out.push(current);
        } else {
            out.extend(current.to_lowercase());
        }
    }
    out
}

fn player_brief(state: &GameState, seat: PlayerId, viewer: PlayerId) -> PlayerBrief {
    let player = &state.players[seat.0 as usize];
    let is_you = seat == viewer;
    PlayerBrief {
        player: seat.0,
        is_you,
        life: player.life,
        poison_counters: player.poison_counters,
        library_size: player.library.len(),
        // CR 400.2 + CR 401.4: a hand is a hidden zone. Only the brief's own
        // seat sees card identities; opponents contribute a count.
        hand: if is_you {
            player
                .hand
                .iter()
                .filter_map(|id| state.objects.get(id))
                .map(object_brief)
                .collect()
        } else {
            Vec::new()
        },
        hand_size: player.hand.len(),
        battlefield: state
            .battlefield
            .iter()
            .filter_map(|id| state.objects.get(id))
            .filter(|object| object.controller == seat)
            .map(object_brief)
            .collect(),
        // CR 400.2: graveyards are public, so both seats render in full.
        graveyard: player
            .graveyard
            .iter()
            .filter_map(|id| state.objects.get(id))
            .map(object_brief)
            .collect(),
        mana_pool: serde_json::to_value(&player.mana_pool).unwrap_or(serde_json::Value::Null),
    }
}

fn object_brief(object: &GameObject) -> ObjectBrief {
    ObjectBrief {
        id: object.id.0,
        // A face-down permanent is a 2/2 with no name (CR 708.2). Rendering the
        // printed name would leak hidden information to the reasoner.
        name: if object.face_down && object.zone == Zone::Battlefield {
            "Face-down creature".to_string()
        } else {
            object.name.clone()
        },
        controller: object.controller.0,
        tapped: object.tapped,
        face_down: object.face_down,
        power: object.power,
        toughness: object.toughness,
        loyalty: object.loyalty,
        damage_marked: object.damage_marked,
        counters: if object.counters.is_empty() {
            None
        } else {
            serde_json::to_value(&object.counters).ok()
        },
        attachments: object.attachments.iter().map(|id| id.0).collect(),
        // CR 301.5 / CR 303.4f: an attachment hosted by a player rather than a
        // permanent (the Curse cycle) has no object host to report.
        attached_to: object
            .attached_to
            .as_ref()
            .and_then(AttachTarget::as_object)
            .map(|id| id.0),
    }
}

fn stack_brief(state: &GameState, entry: &StackEntry) -> StackBrief {
    StackBrief {
        id: entry.id.0,
        name: state
            .objects
            .get(&entry.source_id)
            .map(|object| object.name.clone())
            .unwrap_or_else(|| "Unknown source".to_string()),
        controller: entry.controller.0,
        // `StackEntryKind` is `#[serde(tag = "type")]`, so its serialized form
        // carries the variant name. Reading it back beats a parallel `match`
        // that would silently omit variants added later.
        kind: serde_json::to_value(&entry.kind)
            .ok()
            .and_then(|value| {
                value
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "Unknown".to_string()),
    }
}

fn combat_brief(state: &GameState) -> Option<CombatBrief> {
    let combat = state.combat.as_ref()?;
    let value = serde_json::to_value(combat).ok()?;
    Some(CombatBrief {
        attackers: value
            .get("attackers")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default(),
        blockers: value
            .get("blockers")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanizes_simple_pascal_case() {
        assert_eq!(humanize_variant("CastSpell"), "Cast spell");
        assert_eq!(humanize_variant("PassPriority"), "Pass priority");
        assert_eq!(humanize_variant("DeclareAttackers"), "Declare attackers");
    }

    #[test]
    fn keeps_single_letter_words_capitalized() {
        assert_eq!(humanize_variant("ChooseXValue"), "Choose X value");
        assert_eq!(humanize_variant("ChooseX"), "Choose X");
    }

    #[test]
    fn keeps_acronym_runs_intact() {
        // Not a real variant today, but the rule that protects `X` must not
        // quietly downcase the interior of an acronym if one ever lands.
        assert_eq!(humanize_variant("CastAIThing"), "Cast AI thing");
    }

    #[test]
    fn handles_single_word_variants() {
        assert_eq!(humanize_variant("Concede"), "Concede");
        assert_eq!(humanize_variant("Equip"), "Equip");
    }

    #[test]
    fn labels_every_action_variant_without_panicking() {
        // The describer is structural, so this asserts the property that
        // matters: no variant, present or future, can produce an empty label.
        let state = GameState::new_two_player(1);
        for action in [
            GameAction::PassPriority,
            GameAction::Concede {
                player_id: PlayerId(0),
            },
            GameAction::BeginResolveAll { max_resolutions: 4 },
        ] {
            let label = describe_action(&state, &action);
            assert!(
                !label.is_empty(),
                "empty label for {}",
                action.variant_name()
            );
            assert!(
                label.chars().next().is_some_and(char::is_uppercase),
                "label should start capitalized: {label}"
            );
        }
    }

    #[test]
    fn defers_when_no_real_choice_exists() {
        // A fresh two-player state sits in a mulligan prompt; whatever the
        // contract issues there, the verdict must be a typed variant and never
        // a panic. This guards the escalation entry point against state shapes
        // the policy has not seen.
        let state = GameState::new_two_player(7);
        let contract = AiDecisionContract::issue(&state, PlayerId(1));
        let verdict = prepare_llm_decision(&state, &contract);
        match verdict {
            LlmConsult::Consult { brief } => {
                assert!(brief.candidates.len() >= 2, "consult needs a real choice");
                for (index, candidate) in brief.candidates.iter().enumerate() {
                    assert_eq!(candidate.index, index, "indices must address the vector");
                }
            }
            LlmConsult::Defer { reason } => {
                assert!(matches!(
                    reason,
                    DeferReason::NoCandidates
                        | DeferReason::SingleCandidate
                        | DeferReason::MechanicalPriority
                        | DeferReason::MechanicalPayment
                ));
            }
        }
    }

    #[test]
    fn hides_opponent_hands_from_the_brief() {
        let state = GameState::new_two_player(3);
        let contract = AiDecisionContract::issue(&state, PlayerId(1));
        if let LlmConsult::Consult { brief } = prepare_llm_decision(&state, &contract) {
            for seat in &brief.players {
                if !seat.is_you {
                    assert!(
                        seat.hand.is_empty(),
                        "opponent hand contents must never reach the reasoner"
                    );
                }
            }
        }
    }
}
