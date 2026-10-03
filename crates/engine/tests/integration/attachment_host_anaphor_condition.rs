//! "Put a +1/+1 counter on equipped creature if it's red": the anaphor binds the
//! attachment host.
//!
//! Oracle (Ring of Valkas, and the rest of the M13 Ring cycle with other colors):
//! > Equipped creature has haste.
//! > At the beginning of your upkeep, put a +1/+1 counter on equipped creature
//! > if it's red.
//! > Equip {1}
//!
//! The clause parses to a `PutCounter` on `EquippedBy` gated by
//! `TargetMatchesFilter { HasColor Red }`. The equipped creature is never a
//! declared target, so the condition found no object to test and failed
//! closed: the Ring never added a counter, in a normal upkeep or in the extra
//! upkeeps Obeka, Splitter of Seconds creates.
//!
//! CR 608.2c: "it" reads back to the equipped creature named earlier in the
//! same instruction. CR 301.5 / CR 303.4: an Equipment or Aura's host is
//! determined by the attachment. CR 503.1a: upkeep triggers. CR 500.10 +
//! CR 500.11: Obeka's created upkeep steps.

use engine::game::scenario::{GameRunner, GameScenario, P0};
use engine::types::actions::GameAction;
use engine::types::counter::CounterType;
use engine::types::events::GameEvent;
use engine::types::game_state::WaitingFor;
use engine::types::identifiers::ObjectId;
use engine::types::mana::ManaColor;
use engine::types::phase::Phase;

use super::rules::run_combat;

const RING_OF_VALKAS: &str = "Equipped creature has haste.\nAt the beginning of your upkeep, \
put a +1/+1 counter on equipped creature if it's red.\nEquip {1}";

/// Not a printed card: the Aura counterpart of the Ring cycle's clause, so the
/// `EnchantedBy` host is covered alongside `EquippedBy`.
const GREEN_GROWTH_AURA: &str = "Enchant creature\nAt the beginning of your upkeep, \
put a +1/+1 counter on enchanted creature if it's green.";

const OBEKA: &str = "Menace\nWhenever Obeka deals combat damage to a player, \
you get that many additional upkeep steps after this phase.";

/// Attaches `attachment` to `host` directly, then recomputes layers.
fn attach(runner: &mut GameRunner, attachment: ObjectId, host: ObjectId) {
    let state = runner.state_mut();
    state.objects.get_mut(&attachment).unwrap().attached_to = Some(host.into());
    state
        .objects
        .get_mut(&host)
        .unwrap()
        .attachments
        .push(attachment);
    state.layers_dirty.mark_full();
    engine::game::layers::flush_layers(runner.state_mut());
}

fn plus_one_counters(runner: &GameRunner, id: ObjectId) -> u32 {
    runner.state().objects[&id]
        .counters
        .get(&CounterType::Plus1Plus1)
        .copied()
        .unwrap_or(0)
}

/// The two attachment kinds whose host is the clause's subject.
enum Attachment {
    /// CR 301.5: an artifact attached by equip, named "equipped creature".
    Equipment,
    /// CR 303.4: an enchantment attached by enchant, named "enchanted creature".
    Aura,
}

/// Builds a creature of `color` wearing an attachment with `oracle`, runs P0's
/// next untap and upkeep, and returns the creature's +1/+1 counters.
fn counters_after_one_upkeep(color: ManaColor, kind: Attachment, name: &str, oracle: &str) -> u32 {
    let mut scenario = GameScenario::new();
    let creature = scenario
        .add_creature(P0, "Wearer", 2, 2)
        .with_color(vec![color])
        .id();
    let attachment = match kind {
        Attachment::Equipment => scenario
            .add_artifact_from_oracle(P0, name, oracle)
            .with_subtypes(vec!["Equipment"])
            .id(),
        Attachment::Aura => scenario
            .add_enchantment_from_oracle(P0, name, oracle)
            .with_subtypes(vec!["Aura"])
            .id(),
    };
    scenario.add_card_to_library_top(P0, "Island");
    let mut runner = scenario.build();
    attach(&mut runner, attachment, creature);
    {
        // A previous turn's permanents entering P0's untap step.
        let state = runner.state_mut();
        state.turn_number = 2;
        state.phase = Phase::Untap;
        state.active_player = P0;
        state.priority_player = P0;
        state.waiting_for = WaitingFor::Priority { player: P0 };
    }

    runner.auto_advance_to_main_phase();
    runner.advance_until_stack_empty();
    plus_one_counters(&runner, creature)
}

/// CR 608.2c + CR 503.1a: a red equipped creature gets the counter.
#[test]
fn ring_of_valkas_counters_a_red_equipped_creature() {
    let counters = counters_after_one_upkeep(
        ManaColor::Red,
        Attachment::Equipment,
        "Ring of Valkas",
        RING_OF_VALKAS,
    );
    assert_eq!(counters, 1);
}

/// CR 608.2c: the color check reads the equipped creature, so a nonred one gets
/// nothing. Pairs with the red case to prove the gate discriminates rather than
/// always passing.
#[test]
fn ring_of_valkas_skips_a_nonred_equipped_creature() {
    let counters = counters_after_one_upkeep(
        ManaColor::Blue,
        Attachment::Equipment,
        "Ring of Valkas",
        RING_OF_VALKAS,
    );
    assert_eq!(counters, 0);
}

/// CR 608.2c + CR 303.4: the same clause on an Aura binds the enchanted creature.
#[test]
fn aura_counters_its_enchanted_creature_when_the_color_matches() {
    let green = counters_after_one_upkeep(
        ManaColor::Green,
        Attachment::Aura,
        "Green Growth",
        GREEN_GROWTH_AURA,
    );
    let red = counters_after_one_upkeep(
        ManaColor::Red,
        Attachment::Aura,
        "Green Growth",
        GREEN_GROWTH_AURA,
    );
    assert_eq!((green, red), (1, 0));
}

/// CR 500.10 + CR 500.11 + CR 503.1a: Obeka wearing Ring of Valkas deals 2
/// combat damage, gets two created upkeep steps after combat, and the Ring
/// triggers in each, for two counters by the postcombat main phase.
#[test]
fn obeka_wearing_ring_of_valkas_gets_a_counter_in_each_created_upkeep() {
    let mut scenario = GameScenario::new();
    scenario.at_phase(Phase::PreCombatMain);
    let obeka = scenario
        .add_creature_from_oracle(P0, "Obeka, Splitter of Seconds", 2, 5, OBEKA)
        .with_color(vec![ManaColor::Blue, ManaColor::Black, ManaColor::Red])
        .id();
    let ring = scenario
        .add_artifact_from_oracle(P0, "Ring of Valkas", RING_OF_VALKAS)
        .with_subtypes(vec!["Equipment"])
        .id();
    let mut runner = scenario.build();
    attach(&mut runner, ring, obeka);

    run_combat(&mut runner, vec![obeka], vec![]);
    runner.advance_until_stack_empty();

    let mut upkeeps_entered = 0;
    for _ in 0..40 {
        let result = runner
            .act(GameAction::PassPriority)
            .expect("passing priority should succeed");
        for event in &result.events {
            if let GameEvent::PhaseChanged { phase } = event {
                upkeeps_entered += usize::from(*phase == Phase::Upkeep);
            }
        }
        if runner.state().phase == Phase::PostCombatMain {
            break;
        }
    }

    assert_eq!(runner.state().phase, Phase::PostCombatMain);
    // Reach guard: both created upkeeps ran, so a missing counter is the Ring.
    assert_eq!(upkeeps_entered, 2);
    assert_eq!(plus_one_counters(&runner, obeka), 2);
}
