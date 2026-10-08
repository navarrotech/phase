//! CR 121.2 + CR 121.2a: a draw cost is one instruction of its printed size
//! wherever it is paid; driven through the production chain resolver for
//! `Effect::PayCost` (no printed card carries a multi-card draw cost — the
//! typed-input contract).
//!
//! Every row resolves a real `ResolvedAbility` through
//! `effects::resolve_ability_chain`, and every negative row is paired with a
//! positive reach guard on the same board.

use engine::game::effects::resolve_ability_chain;
use engine::game::scenario::{GameRunner, GameScenario, P0, P1};
use engine::types::ability::{AbilityCost, Effect, QuantityExpr, ResolvedAbility, TargetFilter};
use engine::types::phase::Phase;
use engine::types::player::PlayerId;

/// Alms Collector, verbatim Oracle text: an instruction-level CR 121.2a
/// replacement that applies only to an instruction to draw two or more cards.
const ALMS_COLLECTOR_ORACLE: &str = "Flash\nIf an opponent would draw two or more cards, \
instead you and that player each draw a card.";

/// Enough cards that every row's draws stay legal for both players.
const STAGED_LIBRARY: [&str; 12] = [
    "Library 1",
    "Library 2",
    "Library 3",
    "Library 4",
    "Library 5",
    "Library 6",
    "Library 7",
    "Library 8",
    "Library 9",
    "Library 10",
    "Library 11",
    "Library 12",
];

/// One `cards`-card draw instruction by the ability's controller.
fn draw_effect(cards: i32) -> Effect {
    Effect::Draw {
        count: QuantityExpr::Fixed { value: cards },
        target: TargetFilter::Controller,
    }
}

fn draw_cost(cards: i32) -> AbilityCost {
    AbilityCost::EffectCost {
        effect: Box::new(draw_effect(cards)),
    }
}

/// Signed hand and library changes for both players, and whether the payment
/// was reported as failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Deltas {
    p0_hand: i64,
    p1_hand: i64,
    p0_library: i64,
    p1_library: i64,
    payment_failed: bool,
}

fn hand_and_library(runner: &GameRunner, player: PlayerId) -> (i64, i64) {
    let player_state = &runner.state().players[player.0 as usize];
    (
        player_state.hand.len() as i64,
        player_state.library.len() as i64,
    )
}

/// P0 resolves `effect` from a source creature in their main phase, with Alms
/// Collector under P1 when `with_alms` is set. Both libraries are staged.
fn resolve_on_board(effect: Effect, with_alms: bool) -> Deltas {
    let mut scenario = GameScenario::new();
    scenario.at_phase(Phase::PreCombatMain);
    scenario.with_library_top(P0, &STAGED_LIBRARY);
    scenario.with_library_top(P1, &STAGED_LIBRARY);
    let source = scenario.add_creature(P0, "Draw Cost Source", 1, 1).id();
    if with_alms {
        scenario.add_creature_from_oracle(P1, "Alms Collector", 3, 4, ALMS_COLLECTOR_ORACLE);
    }
    let mut runner = scenario.build();
    let (p0_hand_before, p0_library_before) = hand_and_library(&runner, P0);
    let (p1_hand_before, p1_library_before) = hand_and_library(&runner, P1);

    let ability = ResolvedAbility::new(effect, vec![], source, P0);
    let mut events = Vec::new();
    resolve_ability_chain(runner.state_mut(), &ability, &mut events, 0)
        .expect("the draw effect or draw cost resolves");

    let (p0_hand_after, p0_library_after) = hand_and_library(&runner, P0);
    let (p1_hand_after, p1_library_after) = hand_and_library(&runner, P1);
    Deltas {
        p0_hand: p0_hand_after - p0_hand_before,
        p1_hand: p1_hand_after - p1_hand_before,
        p0_library: p0_library_after - p0_library_before,
        p1_library: p1_library_after - p1_library_before,
        payment_failed: runner.state().cost_payment_failed_flag,
    }
}

/// CR 121.2 + CR 121.2a: a two-card draw cost is ONE instruction to draw two
/// cards, so Alms Collector ("two or more cards") applies to it: P0 and P1 each
/// draw one. A one-card cost is outside Alms Collector's reach, and CR 702.24a
/// repetition (a `Composite` of one-card legs) stays two one-card instructions,
/// never one summed instruction.
#[test]
fn a_two_card_draw_cost_is_one_instruction() {
    // Reach guard: Alms Collector is live on this board for an ordinary two-card draw.
    let ordinary = resolve_on_board(draw_effect(2), true);
    assert_eq!(
        (ordinary.p0_library, ordinary.p1_library),
        (-1, -1),
        "Alms Collector replaces an ordinary two-card draw, got {ordinary:?}"
    );

    // 0-candidate row: with no replacement the two-card cost draws two cards.
    let unreplaced = resolve_on_board(
        Effect::PayCost {
            cost: draw_cost(2),
            scale: None,
            payer: TargetFilter::Controller,
        },
        false,
    );
    assert_eq!(
        unreplaced,
        Deltas {
            p0_hand: 2,
            p1_hand: 0,
            p0_library: -2,
            p1_library: 0,
            payment_failed: false,
        },
        "an unreplaced two-card draw cost draws two cards"
    );

    let two_card_cost = resolve_on_board(
        Effect::PayCost {
            cost: draw_cost(2),
            scale: None,
            payer: TargetFilter::Controller,
        },
        true,
    );
    assert_eq!(
        two_card_cost,
        Deltas {
            p0_hand: 1,
            p1_hand: 1,
            p0_library: -1,
            p1_library: -1,
            payment_failed: false,
        },
        "Alms Collector applies to a two-card draw cost: one card for each player"
    );

    let one_card_cost = resolve_on_board(
        Effect::PayCost {
            cost: draw_cost(1),
            scale: None,
            payer: TargetFilter::Controller,
        },
        true,
    );
    assert_eq!(
        one_card_cost,
        Deltas {
            p0_hand: 1,
            p1_hand: 0,
            p0_library: -1,
            p1_library: 0,
            payment_failed: false,
        },
        "Alms Collector does not apply to a one-card draw cost"
    );

    let repeated_one_card_cost = resolve_on_board(
        Effect::PayCost {
            cost: AbilityCost::Composite {
                costs: vec![draw_cost(1), draw_cost(1)],
            },
            scale: None,
            payer: TargetFilter::Controller,
        },
        true,
    );
    assert_eq!(
        repeated_one_card_cost,
        Deltas {
            p0_hand: 2,
            p1_hand: 0,
            p0_library: -2,
            p1_library: 0,
            payment_failed: false,
        },
        "CR 702.24a: two one-card legs are two one-card instructions, never one two-card instruction"
    );
}
