//! Squandered Resources: "Sacrifice a land: Add one mana of any type the
//! sacrificed land could produce."
//!
//! Scryfall ruling: "Can sacrifice a land which can't produce mana, but you
//! don't get any mana from this ability."
//!
//! CR 106.7 — the type of mana a permanent "could produce" is any type an
//! ability of that permanent would produce if it resolved now, ignoring whether
//! its costs could be paid. CR 106.5 — an ability that would produce mana of an
//! undefined type produces no mana. CR 608.2k + CR 400.7j — "the sacrificed
//! land" is the untargeted object the cost moved; CR 608.2h reads it through
//! last known information. CR 605.1a — the ability is a mana ability, so it
//! resolves without the stack (CR 605.3b) and can be activated while paying a
//! spell's cost (CR 605.3a + CR 117.1d + CR 601.2g).
//!
//! Every row drives the real pipeline (`ActivateAbility` → `PayCost` →
//! `SelectCards` → optional `ChooseManaColor`) and asserts that the sacrifice
//! really ran before asserting what mana arrived.

use engine::ai_support::legal_actions;
use engine::game::casting::can_cast_object_now;
use engine::game::layers::flush_layers;
use engine::game::mana_abilities::can_activate_mana_ability_now;
use engine::game::scenario::{GameRunner, GameScenario, P0, P1};
use engine::types::ability::{Effect, ManaProduction};
use engine::types::actions::GameAction;
use engine::types::events::GameEvent;
use engine::types::game_state::{
    CastPaymentMode, GameState, ManaChoice, ManaChoicePrompt, PayCostKind, WaitingFor,
};
use engine::types::identifiers::ObjectId;
use engine::types::mana::{ManaColor, ManaCost, ManaCostShard, ManaType};
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::zones::Zone;

// Verbatim Oracle text (Scryfall).
const SQUANDERED_RESOURCES: &str =
    "Sacrifice a land: Add one mana of any type the sacrificed land could produce.";
const WASTES: &str = "{T}: Add {C}.";
const SIMIC_GUILDGATE: &str = "This land enters tapped.\n{T}: Add {G} or {U}.";
const EVOLVING_WILDS: &str = "{T}, Sacrifice this land: Search your library for a basic land \
     card, put it onto the battlefield tapped, then shuffle.";
const URBORG: &str = "Each land is a Swamp in addition to its other land types.";
const REFLECTING_POOL: &str =
    "{T}: Add one mana of any type that a land you control could produce.";

/// What one Squandered Resources activation surfaced before it finished.
struct Activation {
    /// The `ChooseManaColor` options, when the activation paused for a choice.
    /// `None` means the mana arrived without a prompt.
    prompt_options: Option<Vec<ManaType>>,
}

fn board() -> (GameScenario, ObjectId) {
    let mut scenario = GameScenario::new();
    scenario.at_phase(Phase::PreCombatMain);
    let squandered = scenario
        .add_enchantment_from_oracle(P0, "Squandered Resources", SQUANDERED_RESOURCES)
        .id();
    (scenario, squandered)
}

/// Activates Squandered Resources and sacrifices `land` to it. Stops at the
/// colour prompt (returning its options) or once the mana has arrived.
///
/// There is deliberately no `PassPriority` arm: a non-empty stack hits the
/// panic arm, so reaching the end proves the ability resolved as a mana ability
/// without using the stack (CR 605.3b).
fn activate_and_sacrifice(
    runner: &mut GameRunner,
    squandered: ObjectId,
    land: ObjectId,
) -> Activation {
    runner
        .act(GameAction::ActivateAbility {
            source_id: squandered,
            ability_index: 0,
        })
        .expect("reach-guard: Squandered Resources must be activatable");

    let mut saw_sacrifice_prompt = false;
    for _ in 0..8 {
        match runner.state().waiting_for.clone() {
            WaitingFor::PayCost {
                kind: PayCostKind::Sacrifice,
                choices,
                ..
            } => {
                assert!(
                    choices.contains(&land),
                    "reach-guard: the land must be offered to the sacrifice cost; got {choices:?}"
                );
                saw_sacrifice_prompt = true;
                runner
                    .act(GameAction::SelectCards { cards: vec![land] })
                    .expect("sacrificing the chosen land must succeed");
            }
            WaitingFor::ChooseManaColor {
                choice: ManaChoicePrompt::SingleColor { options },
                ..
            } => {
                assert!(
                    saw_sacrifice_prompt,
                    "the colour prompt follows the sacrifice"
                );
                return Activation {
                    prompt_options: Some(options),
                };
            }
            WaitingFor::Priority { .. } if runner.state().stack.is_empty() => break,
            WaitingFor::ManaPayment { .. } => break,
            other => panic!("unexpected state while activating Squandered Resources: {other:?}"),
        }
    }

    assert!(
        saw_sacrifice_prompt,
        "reach-guard: the sacrifice cost prompt must have been surfaced"
    );
    Activation {
        prompt_options: None,
    }
}

fn choose(runner: &mut GameRunner, mana_type: ManaType) {
    runner
        .act(GameAction::ChooseManaColor {
            choice: ManaChoice::SingleColor(mana_type),
            count: 1,
        })
        .expect("a type from the prompt must be accepted");
}

fn pool(runner: &GameRunner, player: PlayerId) -> Vec<ManaType> {
    runner.state().players[player.0 as usize]
        .mana_pool
        .mana
        .iter()
        .map(|unit| unit.color)
        .collect()
}

fn sorted(mut types: Vec<ManaType>) -> Vec<ManaType> {
    types.sort_by_key(|mana_type| format!("{mana_type:?}"));
    types
}

fn assert_in_graveyard(runner: &GameRunner, land: ObjectId) {
    assert_eq!(
        runner.state().objects[&land].zone,
        Zone::Graveyard,
        "reach-guard: the sacrifice cost must have moved the land to the graveyard"
    );
}

fn tap(runner: &mut GameRunner, object_id: ObjectId) {
    runner
        .state_mut()
        .objects
        .get_mut(&object_id)
        .expect("the object exists")
        .tapped = true;
}

/// T1: a Forest could produce only {G}, so Squandered adds {G} with no prompt.
#[test]
fn sacrificed_forest_adds_green() {
    let (mut scenario, squandered) = board();
    let forest = scenario.add_basic_land(P0, ManaColor::Green);
    let mut runner = scenario.build();

    let activation = activate_and_sacrifice(&mut runner, squandered, forest);

    assert_in_graveyard(&runner, forest);
    assert_eq!(activation.prompt_options, None);
    assert_eq!(pool(&runner, P0), vec![ManaType::Green]);
}

/// T2: the referent is the sacrificed land, not every land you control. An
/// untapped Island stays on the battlefield and contributes nothing.
#[test]
fn only_the_sacrificed_land_is_consulted() {
    let (mut scenario, squandered) = board();
    let forest = scenario.add_basic_land(P0, ManaColor::Green);
    let island = scenario.add_basic_land(P0, ManaColor::Blue);
    let mut runner = scenario.build();

    let activation = activate_and_sacrifice(&mut runner, squandered, forest);

    assert_in_graveyard(&runner, forest);
    let island_object = &runner.state().objects[&island];
    assert_eq!(island_object.zone, Zone::Battlefield);
    assert!(
        !island_object.tapped,
        "reach-guard: the Island stays untapped"
    );
    assert_eq!(activation.prompt_options, None);
    assert_eq!(pool(&runner, P0), vec![ManaType::Green]);
}

/// T3: a dual land offers exactly its two types, and a type outside that set
/// is refused.
#[test]
fn sacrificed_dual_land_offers_both_of_its_types() {
    let (mut scenario, squandered) = board();
    let guildgate = scenario
        .add_land_from_oracle(P0, "Simic Guildgate", SIMIC_GUILDGATE)
        .id();
    let mut runner = scenario.build();

    let activation = activate_and_sacrifice(&mut runner, squandered, guildgate);

    assert_in_graveyard(&runner, guildgate);
    let options = activation
        .prompt_options
        .expect("a two-type land must prompt for the type");
    assert_eq!(
        sorted(options),
        sorted(vec![ManaType::Green, ManaType::Blue])
    );
    assert!(
        runner
            .act(GameAction::ChooseManaColor {
                choice: ManaChoice::SingleColor(ManaType::Black),
                count: 1,
            })
            .is_err(),
        "a type the sacrificed land could not produce must be refused"
    );
    choose(&mut runner, ManaType::Blue);
    assert_eq!(pool(&runner, P0), vec![ManaType::Blue]);
}

/// T4: "type" includes colorless (CR 106.1b), so Wastes gives {C}.
#[test]
fn sacrificed_wastes_adds_colorless() {
    let (mut scenario, squandered) = board();
    let wastes = scenario.add_land_from_oracle(P0, "Wastes", WASTES).id();
    let mut runner = scenario.build();

    let activation = activate_and_sacrifice(&mut runner, squandered, wastes);

    assert_in_graveyard(&runner, wastes);
    assert_eq!(activation.prompt_options, None);
    assert_eq!(pool(&runner, P0), vec![ManaType::Colorless]);
}

/// T5: a land with no mana ability is still a legal sacrifice, but it could
/// produce no type, so no mana is added (Scryfall ruling + CR 106.5).
#[test]
fn sacrificed_land_without_mana_abilities_adds_nothing() {
    let (mut scenario, squandered) = board();
    let wilds = scenario
        .add_land_from_oracle(P0, "Evolving Wilds", EVOLVING_WILDS)
        .id();
    let mut runner = scenario.build();

    let activation = activate_and_sacrifice(&mut runner, squandered, wilds);

    assert_in_graveyard(&runner, wilds);
    assert_eq!(activation.prompt_options, None);
    assert!(
        pool(&runner, P0).is_empty(),
        "a land that could produce no mana yields no mana"
    );
}

/// T6: the could-produce set is read as the land last existed on the
/// battlefield (CR 608.2h). Urborg makes the Wastes a Swamp, which grants it
/// "{T}: Add {B}" (CR 305.6); that ability is gone once the Wastes is in the
/// graveyard, so only last known information can supply {B}.
#[test]
fn sacrificed_land_uses_its_layered_abilities_as_it_last_existed() {
    let (mut scenario, squandered) = board();
    scenario.add_land_from_oracle(P0, "Urborg, Tomb of Yawgmoth", URBORG);
    let wastes = scenario.add_land_from_oracle(P0, "Wastes", WASTES).id();
    let mut runner = scenario.build();
    runner.state_mut().layers_dirty.mark_full();
    flush_layers(runner.state_mut());

    let wastes_produces_black = runner.state().objects[&wastes]
        .abilities
        .iter()
        .any(|ability| match &*ability.effect {
            Effect::Mana {
                produced: ManaProduction::Fixed { colors, .. },
                ..
            } => colors.contains(&ManaColor::Black),
            _ => false,
        });
    assert!(
        wastes_produces_black,
        "reach-guard: Urborg must grant the Wastes the intrinsic Swamp mana ability"
    );

    let activation = activate_and_sacrifice(&mut runner, squandered, wastes);

    assert_in_graveyard(&runner, wastes);
    let options = activation
        .prompt_options
        .expect("a Swamp-Wastes could produce two types");
    assert_eq!(
        sorted(options),
        sorted(vec![ManaType::Colorless, ManaType::Black])
    );
    choose(&mut runner, ManaType::Black);
    assert_eq!(pool(&runner, P0), vec![ManaType::Black]);
}

/// T7: CR 106.7 ignores whether the land's costs could be paid, so a tapped
/// Forest still could produce {G}.
#[test]
fn sacrificed_tapped_forest_still_adds_green() {
    let (mut scenario, squandered) = board();
    let forest = scenario.add_basic_land(P0, ManaColor::Green);
    let mut runner = scenario.build();
    tap(&mut runner, forest);
    assert!(
        runner.state().objects[&forest].tapped,
        "reach-guard: the Forest is tapped before activation"
    );

    let activation = activate_and_sacrifice(&mut runner, squandered, forest);

    assert_in_graveyard(&runner, forest);
    assert_eq!(activation.prompt_options, None);
    assert_eq!(pool(&runner, P0), vec![ManaType::Green]);
}

/// T8: a land you control but do not own goes to its owner's graveyard
/// (CR 701.21a), and its mana still goes to you.
#[test]
fn sacrificed_borrowed_land_goes_to_its_owner_and_mana_to_its_controller() {
    let (mut scenario, squandered) = board();
    let forest = scenario
        .add_land_from_oracle(P1, "Forest", "{T}: Add {G}.")
        .controlled_by(P0)
        .id();
    let mut runner = scenario.build();
    assert_eq!(runner.state().objects[&forest].owner, P1);
    assert_eq!(runner.state().objects[&forest].controller, P0);

    let activation = activate_and_sacrifice(&mut runner, squandered, forest);

    assert_in_graveyard(&runner, forest);
    assert!(
        runner.state().players[P1.0 as usize]
            .graveyard
            .contains(&forest),
        "reach-guard: the Forest goes to its owner's graveyard"
    );
    assert!(!runner.state().players[P0.0 as usize]
        .graveyard
        .contains(&forest));
    assert_eq!(activation.prompt_options, None);
    assert_eq!(pool(&runner, P0), vec![ManaType::Green]);
    assert!(pool(&runner, P1).is_empty());
}

/// T10: a sacrificed Reflecting Pool could produce whatever the lands you
/// control could produce at that moment (CR 106.7), here {G} from a Forest.
#[test]
fn sacrificed_reflecting_pool_adds_what_it_could_produce() {
    let (mut scenario, squandered) = board();
    let pool_land = scenario
        .add_land_from_oracle(P0, "Reflecting Pool", REFLECTING_POOL)
        .id();
    let forest = scenario.add_basic_land(P0, ManaColor::Green);
    let mut runner = scenario.build();

    let activation = activate_and_sacrifice(&mut runner, squandered, pool_land);

    assert_in_graveyard(&runner, pool_land);
    assert_eq!(runner.state().objects[&forest].zone, Zone::Battlefield);
    assert_eq!(activation.prompt_options, None);
    assert_eq!(pool(&runner, P0), vec![ManaType::Green]);
}

fn cast_manually(runner: &mut GameRunner, spell: ObjectId) {
    let card_id = runner.state().objects[&spell].card_id;
    runner
        .act(GameAction::CastSpell {
            object_id: spell,
            card_id,
            targets: vec![],
            payment_mode: CastPaymentMode::Manual,
        })
        .expect("announcing the spell must succeed");
    assert!(
        matches!(runner.state().waiting_for, WaitingFor::ManaPayment { .. }),
        "reach-guard: a manual cast opens the mana payment step, got {:?}",
        runner.state().waiting_for
    );
}

/// Whether the engine's legal-action list offers casting `spell`, which is
/// where the castability gate surfaces to players and the AI.
fn cast_is_offered(state: &GameState, spell: ObjectId) -> bool {
    legal_actions(state).iter().any(
        |action| matches!(action, GameAction::CastSpell { object_id, .. } if *object_id == spell),
    )
}

fn finish_payment_casts(runner: &mut GameRunner, spell: ObjectId) -> bool {
    let result = runner
        .act(GameAction::PassPriority)
        .expect("finishing the mana payment must succeed");
    result
        .events
        .iter()
        .any(|event| matches!(event, GameEvent::SpellCast { object_id, .. } if *object_id == spell))
}

fn green_creature_in_hand(scenario: &mut GameScenario) -> ObjectId {
    scenario
        .add_creature_to_hand(P0, "Test Green Creature", 2, 2)
        .with_mana_cost(ManaCost::Cost {
            shards: vec![ManaCostShard::Green],
            generic: 0,
        })
        .id()
}

fn generic_artifact_in_hand(scenario: &mut GameScenario) -> ObjectId {
    scenario
        .add_artifact_to_hand_from_oracle(P0, "Test Artifact", "")
        .with_mana_cost(ManaCost::Cost {
            shards: vec![],
            generic: 1,
        })
        .id()
}

/// T9: a {G} spell payable only through Squandered Resources is offered
/// (CR 117.1d + CR 601.2g), and sacrificing the only (tapped) Forest during
/// payment pays it (CR 605.3a).
#[test]
fn green_spell_payable_only_through_squandered_is_offered_and_paid() {
    let (mut scenario, squandered) = board();
    let forest = scenario.add_basic_land(P0, ManaColor::Green);
    let spell = green_creature_in_hand(&mut scenario);
    let mut runner = scenario.build();
    tap(&mut runner, forest);

    assert!(
        can_cast_object_now(runner.state(), P0, spell),
        "the castability gate must credit Squandered Resources' {{G}}"
    );
    assert!(
        cast_is_offered(runner.state(), spell),
        "the spell must be among the legal actions"
    );

    cast_manually(&mut runner, spell);
    let activation = activate_and_sacrifice(&mut runner, squandered, forest);
    assert_in_graveyard(&runner, forest);
    assert_eq!(activation.prompt_options, None);
    assert!(
        matches!(runner.state().waiting_for, WaitingFor::ManaPayment { .. }),
        "the mana ability returns to the payment step (CR 605.3a)"
    );
    assert!(
        finish_payment_casts(&mut runner, spell),
        "the {{G}} from the sacrificed Forest must pay for the spell"
    );
}

/// T11: a generic-only spell payable only through Squandered Resources is
/// offered (the capacity branch, not the coloured-shard branch) and resolves.
#[test]
fn generic_spell_payable_only_through_squandered_is_offered_and_resolves() {
    let (mut scenario, squandered) = board();
    let forest = scenario.add_basic_land(P0, ManaColor::Green);
    let spell = generic_artifact_in_hand(&mut scenario);
    let mut runner = scenario.build();
    tap(&mut runner, forest);

    assert!(
        can_cast_object_now(runner.state(), P0, spell),
        "the castability gate must count Squandered Resources' one mana"
    );

    cast_manually(&mut runner, spell);
    activate_and_sacrifice(&mut runner, squandered, forest);
    assert_in_graveyard(&runner, forest);
    assert!(finish_payment_casts(&mut runner, spell));
    runner.advance_until_stack_empty();
    assert_eq!(runner.state().objects[&spell].zone, Zone::Battlefield);
}

/// T12(a): with no land to sacrifice the ability cannot be activated, so a
/// spell that needs its mana is not offered. The otherwise identical board
/// with one tapped Forest is the positive pair.
#[test]
fn spell_is_not_offered_without_a_land_to_sacrifice() {
    let (mut scenario, _squandered) = board();
    let spell = green_creature_in_hand(&mut scenario);
    let runner = scenario.build();

    assert!(!can_cast_object_now(runner.state(), P0, spell));
    assert!(!cast_is_offered(runner.state(), spell));

    let (mut scenario, _squandered) = board();
    let forest = scenario.add_basic_land(P0, ManaColor::Green);
    let spell = green_creature_in_hand(&mut scenario);
    let mut runner = scenario.build();
    tap(&mut runner, forest);
    assert!(
        can_cast_object_now(runner.state(), P0, spell),
        "positive pair: one tapped Forest makes the same spell castable"
    );
    assert!(cast_is_offered(runner.state(), spell));
}

/// T12(b): a land that could produce no mana makes the activation legal but
/// adds nothing (Scryfall ruling + CR 106.5), so neither a {G} nor a {1} spell
/// may be offered.
#[test]
fn spells_are_not_offered_when_the_only_land_could_produce_nothing() {
    let (mut scenario, squandered) = board();
    scenario.add_land_from_oracle(P0, "Evolving Wilds", EVOLVING_WILDS);
    let green_spell = green_creature_in_hand(&mut scenario);
    let generic_spell = generic_artifact_in_hand(&mut scenario);
    let runner = scenario.build();

    let definition = runner.state().objects[&squandered].abilities[0].clone();
    assert!(
        can_activate_mana_ability_now(runner.state(), P0, squandered, 0, &definition),
        "reach-guard: Squandered Resources itself is activatable (Evolving Wilds is fodder)"
    );
    assert!(
        !can_cast_object_now(runner.state(), P0, green_spell),
        "a {{G}} spell must not be offered when no sacrifice could produce mana"
    );
    assert!(
        !can_cast_object_now(runner.state(), P0, generic_spell),
        "a {{1}} spell must not be offered when no sacrifice could produce mana"
    );
    assert!(!cast_is_offered(runner.state(), green_spell));
    assert!(!cast_is_offered(runner.state(), generic_spell));
}
