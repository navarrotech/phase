//! Paired-subject "exchange control of <context-ref> and up to one target X"
//! (Gilded Drake): the declared slot may be left empty.
//!
//! CR 115.6: a spell or ability that requires targets may allow zero targets to
//! be chosen. CR 603.3d: a triggered ability is only removed from the stack when
//! a required choice cannot be made, and "up to one" always has a legal answer
//! (zero targets). CR 701.12a + CR 701.12b: with no second permanent there is no
//! exchange, so "If you don't or can't make an exchange, sacrifice this
//! creature" applies.
//!
//! Rows (phase 1 of the Gilded Drake charter):
//! - T1, positive control: a legal target that stays legal is exchanged and the
//!   Drake is not sacrificed.
//! - T4: zero targets chosen while a legal opponent creature exists, so the
//!   Drake is sacrificed.
//! - T5: no opponent creature at all, so the trigger still goes on the stack and
//!   the Drake is sacrificed.
//!
//! The trailing "This ability still resolves if its target becomes illegal"
//! sentence is out of scope here and stays an unsupported parse.

use engine::game::scenario::{CastCommit, CastOutcome, GameRunner, GameScenario, P0, P1};
use engine::types::ability::TargetRef;
use engine::types::actions::GameAction;
use engine::types::events::GameEvent;
use engine::types::game_state::{StackEntryKind, TargetSelectionSlot, WaitingFor};
use engine::types::identifiers::ObjectId;
use engine::types::mana::ManaCost;
use engine::types::phase::Phase;
use engine::types::zones::Zone;

/// Verbatim from Scryfall (`cards/named?exact=Gilded%20Drake`).
const GILDED_DRAKE_TEXT: &str = "Flying\nWhen this creature enters, exchange control of this \
    creature and up to one target creature an opponent controls. If you don't or can't make an \
    exchange, sacrifice this creature. This ability still resolves if its target becomes illegal.";

/// Upper bound on staging steps. The Drake needs a handful of actions (pass to
/// resolve the spell, answer the trigger prompt); the bound only exists so a
/// broken pipeline fails with a message instead of spinning forever.
const STAGING_STEP_LIMIT: usize = 40;

/// What the staging helper saw on the way to a staged trigger.
#[derive(Debug, Default)]
struct StagingObservation {
    /// The slots of every `TriggerTargetSelection` prompt answered, in order.
    prompts: Vec<Vec<TargetSelectionSlot>>,
}

/// A board with Gilded Drake in P0's hand (free to cast) and, when requested,
/// a Grizzly Bears controlled by P1. P0 is active and holds priority.
fn build_board(with_opponent_creature: bool) -> (GameRunner, ObjectId, Option<ObjectId>) {
    let mut scenario = GameScenario::new();
    scenario.at_phase(Phase::PreCombatMain);
    let bear =
        with_opponent_creature.then(|| scenario.add_creature(P1, "Grizzly Bears", 2, 2).id());
    let drake = scenario
        .add_creature_to_hand_from_oracle(P0, "Gilded Drake", 3, 3, GILDED_DRAKE_TEXT)
        .with_mana_cost(ManaCost::zero())
        .id();

    let mut runner = scenario.build();
    {
        let state = runner.state_mut();
        state.active_player = P0;
        state.priority_player = P0;
        state.waiting_for = WaitingFor::Priority { player: P0 };
    }
    (runner, drake, bear)
}

/// Cast Gilded Drake and drive the real pipeline until its ETB trigger sits on
/// the stack, unresolved, with priority open.
///
/// Every `TriggerTargetSelection` prompt is answered with `answer` (`None`
/// declines the optional slot). The trigger counts as staged only once it is a
/// real stack entry: a pending trigger (`pending_trigger_entry`) still waiting
/// on its target prompt is not staged, because handing priority away at that
/// point would discard the prompt.
fn stage_drake_trigger(
    runner: &mut GameRunner,
    drake: ObjectId,
    answer: Option<ObjectId>,
) -> (CastCommit<'_>, StagingObservation) {
    let mut commit = runner.cast(drake).commit();
    let mut observation = StagingObservation::default();

    for _ in 0..STAGING_STEP_LIMIT {
        let state = commit.state();
        match &state.waiting_for {
            WaitingFor::TriggerTargetSelection { target_slots, .. } => {
                observation.prompts.push(target_slots.clone());
                commit
                    .act(GameAction::ChooseTarget {
                        target: answer.map(TargetRef::Object),
                    })
                    .expect("ChooseTarget should be accepted for the Drake's trigger");
            }
            WaitingFor::Priority { .. } => {
                let drake_on_battlefield =
                    state.objects.get(&drake).map(|object| object.zone) == Some(Zone::Battlefield);
                if drake_on_battlefield
                    && state.pending_trigger_entry.is_none()
                    && drake_trigger_entry(commit.state(), drake).is_some()
                {
                    return (commit, observation);
                }
                assert!(
                    !state.stack.is_empty(),
                    "the stack emptied without the Drake's ETB trigger ever reaching it \
                     (observation so far: {observation:?}, waiting_for: {:?})",
                    state.waiting_for
                );
                commit
                    .act(GameAction::PassPriority)
                    .expect("PassPriority should succeed while staging the trigger");
            }
            other => panic!(
                "unexpected waiting state while staging the Drake's trigger: {other:?} \
                 (observation so far: {observation:?})"
            ),
        }
    }
    panic!(
        "the Drake's ETB trigger was not staged within {STAGING_STEP_LIMIT} steps \
         (observation so far: {observation:?}, waiting_for: {:?})",
        commit.state().waiting_for
    );
}

/// The declared targets of the Drake's ETB trigger on the stack, if it is there.
fn drake_trigger_entry(
    state: &engine::types::game_state::GameState,
    drake: ObjectId,
) -> Option<Vec<TargetRef>> {
    state.stack.iter().find_map(|entry| {
        let is_drake_trigger = entry.source_id == drake
            && matches!(entry.kind, StackEntryKind::TriggeredAbility { .. });
        if !is_drake_trigger {
            return None;
        }
        entry.ability().map(|ability| ability.targets.clone())
    })
}

fn controller_changes(outcome: &CastOutcome) -> usize {
    outcome
        .events()
        .iter()
        .filter(|event| matches!(event, GameEvent::ControllerChanged { .. }))
        .count()
}

fn drake_was_sacrificed(outcome: &CastOutcome, drake: ObjectId) -> bool {
    outcome.events().iter().any(|event| {
        matches!(
            event,
            GameEvent::PermanentSacrificed { object_id, .. } if *object_id == drake
        )
    })
}

/// Assert the trigger raised exactly one prompt whose single slot is optional
/// and offers `bear`.
///
/// This is the reach guard that separates "up to one" from a mandatory slot:
/// a mandatory slot with exactly one legal choice is bound without a prompt.
fn assert_single_optional_prompt_offers(observation: &StagingObservation, bear: ObjectId) {
    let [slots] = observation.prompts.as_slice() else {
        panic!(
            "REACH GUARD: the Drake's trigger must raise exactly one target prompt \
             (observation: {observation:?})"
        );
    };
    let [slot] = slots.as_slice() else {
        panic!("REACH GUARD: the prompt must have exactly one slot (slots: {slots:?})");
    };
    assert!(
        slot.optional,
        "REACH GUARD: CR 115.6 \"up to one target\" makes the slot optional (slot: {slot:?})"
    );
    assert!(
        slot.legal_targets.contains(&TargetRef::Object(bear)),
        "REACH GUARD: the opponent's creature must be a legal choice (slot: {slot:?})"
    );
}

/// T1, positive control. CR 701.12b: the bear is chosen and stays legal, the
/// two permanents have different controllers, so their controllers swap. The
/// exchange happened, so "If you don't or can't make an exchange" is false and
/// the Drake is not sacrificed.
#[test]
fn gilded_drake_exchanges_with_a_chosen_target_and_is_not_sacrificed() {
    let (mut runner, drake, bear) = build_board(true);
    let bear = bear.expect("the board has an opponent creature");

    let (commit, observation) = stage_drake_trigger(&mut runner, drake, Some(bear));
    assert_single_optional_prompt_offers(&observation, bear);
    assert_eq!(
        drake_trigger_entry(commit.state(), drake),
        Some(vec![TargetRef::Object(bear)]),
        "REACH GUARD: the staged trigger carries the chosen bear as its declared target"
    );

    let outcome = commit.resolve();

    assert_eq!(
        controller_changes(&outcome),
        2,
        "REACH GUARD: CR 701.12b swaps both controllers (events were {:?})",
        outcome.events()
    );
    let drake_object = outcome.state().objects.get(&drake).unwrap();
    assert_eq!(
        drake_object.zone,
        Zone::Battlefield,
        "the Drake stays on the battlefield"
    );
    assert_eq!(
        drake_object.controller, P1,
        "the Drake goes to the opponent"
    );
    assert_eq!(
        outcome.state().objects.get(&bear).unwrap().controller,
        P0,
        "and the opponent's creature comes to the Drake's controller"
    );
    assert!(
        !drake_was_sacrificed(&outcome, drake),
        "CR 608.2c: an exchange that happened must not sacrifice the Drake (events were {:?})",
        outcome.events()
    );
}

/// T4. CR 115.6: the controller may choose zero targets for "up to one target".
/// With no second permanent, CR 701.12a says no exchange happens, so the rider
/// sacrifices the Drake while the declined bear stays with its controller.
///
/// Fails on revert: a mandatory slot with exactly one legal creature is bound
/// without a prompt, so the prompt reach guard fails before any outcome check.
#[test]
fn gilded_drake_choosing_no_target_sacrifices_the_drake() {
    let (mut runner, drake, bear) = build_board(true);
    let bear = bear.expect("the board has an opponent creature");

    let (commit, observation) = stage_drake_trigger(&mut runner, drake, None);
    assert_single_optional_prompt_offers(&observation, bear);
    assert_eq!(
        drake_trigger_entry(commit.state(), drake),
        Some(Vec::new()),
        "REACH GUARD: the declined trigger is on the stack with no declared target"
    );

    let outcome = commit.resolve();

    assert!(
        drake_was_sacrificed(&outcome, drake),
        "CR 701.21a: with no exchange made, the Drake's controller sacrifices it \
         (events were {:?})",
        outcome.events()
    );
    let drake_object = outcome.state().objects.get(&drake).unwrap();
    assert_eq!(
        drake_object.zone,
        Zone::Graveyard,
        "the Drake is in a graveyard"
    );
    assert!(
        outcome.state().players[0].graveyard.contains(&drake),
        "the Drake is in its owner P0's graveyard"
    );
    let bear_object = outcome.state().objects.get(&bear).unwrap();
    assert_eq!(
        bear_object.zone,
        Zone::Battlefield,
        "the declined bear is untouched"
    );
    assert_eq!(
        bear_object.controller, P1,
        "the declined bear stays the opponent's"
    );
    assert_eq!(
        controller_changes(&outcome),
        0,
        "no control exchange happens when no target was chosen (events were {:?})",
        outcome.events()
    );
}

/// T5. CR 603.3d: with no opponent creature, "up to one target" still has a
/// legal choice (zero targets), so the trigger goes on the stack rather than
/// being removed. It resolves without an exchange and sacrifices the Drake.
///
/// Fails on revert: the mandatory slot has no legal target, the trigger never
/// reaches the stack, and the staging helper panics with the stack empty.
#[test]
fn gilded_drake_without_an_opponent_creature_still_triggers_and_is_sacrificed() {
    let (mut runner, drake, _) = build_board(false);

    let (commit, _observation) = stage_drake_trigger(&mut runner, drake, None);
    assert_eq!(
        drake_trigger_entry(commit.state(), drake),
        Some(Vec::new()),
        "REACH GUARD: the trigger is on the stack with no declared target"
    );

    let outcome = commit.resolve();

    assert!(
        drake_was_sacrificed(&outcome, drake),
        "CR 701.21a: with no exchange possible, the Drake's controller sacrifices it \
         (events were {:?})",
        outcome.events()
    );
    let drake_object = outcome.state().objects.get(&drake).unwrap();
    assert_eq!(
        drake_object.zone,
        Zone::Graveyard,
        "the Drake is in a graveyard"
    );
    assert!(
        outcome.state().players[0].graveyard.contains(&drake),
        "the Drake is in its owner P0's graveyard"
    );
}
