# AI and combat taxes

How the AI decides whether to pay a "creatures can't attack you unless their
controller pays {N}" cost (Propaganda, Ghostly Prison, Sphere of Safety,
Windborn Muse, Norn's Annex, Archangel of Tithes), and the block-side twin
(CR 509.1c–d).

## The shape of the problem

`handle_declare_attackers` validates a declaration, then, if any attacker is
taxed, pauses at `WaitingFor::CombatTaxPayment` **without committing**.
Declining rebuilds the identical `DeclareAttackers` prompt: per CR 508.1d a
player is never required to pay, and the whole proposal is discarded. Blocks
behave the same way against `DeclareBlockers`.

That rebuild is what makes the AI's two readings of one tax a correctness
concern rather than a tuning concern. A seat that declares a taxed attack and
then declines the resulting quote re-enters the same declare prompt,
re-proposes the same attack, and loops forever.

## The contract

Two seams answer the same question and must agree:

| Seam | Where | Role |
|------|-------|------|
| `plan_attack_tax` / `block_tax_posture` | `policies/combat_tax.rs`, `search.rs` | Before submitting a declaration: is this tax worth paying, and can we pay it? |
| `should_pay_pending_tax` | `policies/combat_tax.rs` | At the live `CombatTaxPayment` prompt: pay or decline? |

Both route through `tax_deltas`, which scores the accept and decline branches of
one quote and is a **pure function of the quote and the game state**. Identical
inputs give identical answers, so an accepted proposal is never declined at its
own prompt. That, not a loop counter, is what makes the round trip terminate.

`deterministic_combat_choice` answers a live tax prompt directly rather than
letting it go through candidate scoring, so no unrelated policy can outvote the
judgement that authorized the declaration. In `choose_action`, that bypass sits
inside `score_candidates_core` and always returns an action, so the
deadlock-safe `fallback_action` is never consulted for a tax prompt.
`CombatTaxPaymentPolicy` keeps scoring taxed lines inside lookahead rollouts,
using the same `tax_deltas`.

## The engine side

`CombatTaxPosture` (`game/combat.rs`) is what a caller tells the completion
authority:

- `Refuse`: any taxed proposal collapses to the deterministic tax-free witness
  (`best_free_declaration`). With no must-attack requirement on the board that
  witness is the **empty** declaration, so a refusing seat simply does not
  attack into a Propaganda.
- `Accept`: the taxed proposal survives, but only while
  `attack_tax_is_affordable` / `block_tax_is_affordable` says the paying player
  can cover the quote. Those probe through
  `casting::can_pay_effect_mana_cost_after_auto_tap`, the same payment path
  `handle_pay_combat_tax` spends through, so the preview and the spend cannot
  disagree.

Everything else still applies: hard legality (CR 508.1a–e) and the CR 508.1d
maximum-requirement bar gate the proposal before the posture is consulted, and
the engine remains the single legality authority. A posture is a request, not an
override.

Engine candidate generation (`ai_support::candidates`) passes `Refuse`. It feeds
rollout and projection scorers, not the production declare seam, and no scorer
there is positioned to commit to a payment.

## Trimming

The tax is charged per attacker (CR 508.1h), so `plan_attack_tax` does not treat
an unaffordable alpha strike as a reason to stay home. It drops the weakest
taxed attacker and re-prices, until the remaining strike is both affordable and
worth its cost. An empty result hands the engine's tax-free witness the final
say, which is also what honours any must-attack requirement the trimming walked
past.

Block proposals are posture-only. They are not trimmed.

## Scoring

`tax_deltas` biases toward paying when the taxed creatures' combined power
exceeds the quote, scaled by deck archetype (aggro amplifies, control dampens),
with a penalty for tapping out of interaction and a bonus when declining would
collapse most of the declaration. The constants live at the top of
`policies/combat_tax.rs`.

## Roadmap

- Block proposals get the same per-blocker trimming the attack side has.
- Tax cost is not yet an input to attacker *valuation*. The AI picks its strike
  first and prices it second, so it cannot trade a big attacker's tax against a
  cheaper line during selection.
