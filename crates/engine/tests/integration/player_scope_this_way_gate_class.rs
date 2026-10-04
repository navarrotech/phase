//! The "each player <verb>s … <noun> <verb>ed this way" class (#9225), beyond
//! Locke: a "this way" gate that follows a `player_scope` instruction is ONE
//! look-back over the whole multi-player action unless the gated clause names
//! the iterated player.
//!
//! CR anchors:
//!   - CR 608.2f: an action taken on multiple players is one action, processed
//!     per player only when it can't be processed simultaneously.
//!   - CR 608.2c: the following instruction reads that action's result, and
//!     "that many" names the population of the gate it follows (the rules of
//!     English: its nearest antecedent).
//!
//! Every fixture has four players, because a per-player defect in this class
//! can coincide with the correct answer in a two-player game.

use engine::game::combat::AttackTarget;
use engine::game::scenario::{GameRunner, GameScenario, P0, P1};
use engine::types::counter::CounterType;
use engine::types::identifiers::ObjectId;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;

const PLAYER_COUNT: u8 = 4;
const P2: PlayerId = PlayerId(2);
const P3: PlayerId = PlayerId(3);
const ALL_PLAYERS: [PlayerId; 4] = [P0, P1, P2, P3];

/// Verbatim Oracle text (Scryfall `cards/named?exact=Augusta, Order Returned`).
const AUGUSTA: &str = "Flying, vigilance\n\
     Whenever Augusta attacks, each player exiles a card from their graveyard. \
     When one or more nonland cards are exiled this way, put that many +1/+1 \
     counters on target attacking creature.";

/// Four players, each with exactly one card in their graveyard: a nonland card
/// for every player in `nonland_exiled_by`, a land for the rest. Augusta (P0)
/// attacks alone, so she is the only legal "target attacking creature".
/// Returns the runner after the trigger has resolved, Augusta, and the staged
/// graveyard cards in seat order.
fn augusta_attacks(nonland_exiled_by: &[PlayerId]) -> (GameRunner, ObjectId, Vec<ObjectId>) {
    let mut scenario = GameScenario::new_n_player(PLAYER_COUNT, 9225);
    scenario.at_phase(Phase::PreCombatMain);
    let augusta = scenario
        .add_creature_from_oracle(P0, "Augusta, Order Returned", 2, 2, AUGUSTA)
        .id();
    let staged: Vec<ObjectId> = ALL_PLAYERS
        .iter()
        .map(|&player| {
            if nonland_exiled_by.contains(&player) {
                scenario
                    .add_creature_to_graveyard(player, "Exiled Creature Card", 1, 1)
                    .id()
            } else {
                scenario
                    .add_land_to_graveyard(player, "Exiled Land Card")
                    .id()
            }
        })
        .collect();
    let mut runner = scenario.build();
    runner.advance_to_combat();
    runner
        .declare_attackers(&[(augusta, AttackTarget::Player(P1))])
        .expect("Augusta must be able to attack");
    runner.advance_until_stack_empty();
    (runner, augusta, staged)
}

fn plus_counters(runner: &GameRunner, object: ObjectId) -> u32 {
    runner.state().objects[&object]
        .counters
        .get(&CounterType::Plus1Plus1)
        .copied()
        .unwrap_or(0)
}

fn assert_every_staged_card_was_exiled(runner: &GameRunner, staged: &[ObjectId]) {
    for (seat, id) in staged.iter().enumerate() {
        assert_eq!(
            runner.state().objects[id].zone,
            Zone::Exile,
            "reach guard: player {seat} must have exiled their only graveyard card"
        );
    }
}

/// CR 608.2c + CR 608.2f: every player exiles a nonland card, so "that many"
/// is four, placed once on Augusta.
#[test]
fn augusta_counts_every_players_nonland_exile() {
    let (runner, augusta, staged) = augusta_attacks(&ALL_PLAYERS);
    assert_every_staged_card_was_exiled(&runner, &staged);

    assert_eq!(
        plus_counters(&runner, augusta),
        4,
        "four nonland cards were exiled this way — Augusta gets four counters"
    );
}

/// CR 608.2c: "that many" is the NONLAND cards exiled this way, not every card
/// the instruction exiled. Two nonland cards and two lands → two counters. A
/// count of the whole clause result would give four.
#[test]
fn augusta_counts_only_the_nonland_cards_exiled() {
    let (runner, augusta, staged) = augusta_attacks(&[P0, P1]);
    assert_every_staged_card_was_exiled(&runner, &staged);

    assert_eq!(
        plus_counters(&runner, augusta),
        2,
        "only the two nonland cards count toward \"that many\""
    );
}

/// CR 608.2c: no nonland card was exiled, so the gate is false and no counter
/// is placed — the gate discriminates rather than always firing.
#[test]
fn augusta_places_no_counter_when_only_lands_were_exiled() {
    let (runner, augusta, staged) = augusta_attacks(&[]);
    assert_every_staged_card_was_exiled(&runner, &staged);

    assert_eq!(plus_counters(&runner, augusta), 0);
}
