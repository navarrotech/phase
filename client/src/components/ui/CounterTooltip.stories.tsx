import type { Meta, StoryObj } from "@storybook/react-vite";

import { userEvent, within } from "storybook/test";

import { COUNTER_COLORS } from "../../viewmodel/cardProps.ts";
import { CounterTooltip } from "./CounterTooltip.tsx";

/**
 * Wraps a counter pill and explains what that counter does on hover or focus.
 * The tooltip itself portals to `document.body` so it escapes the transformed,
 * overflow-clipped stacking context of a rotating battlefield card.
 *
 * Each story hovers its own pill on load, so the catalog shows the tooltip
 * rather than the pill alone.
 */
const meta = {
  title: "UI/CounterTooltip",
  component: CounterTooltip,
  args: {
    type: "P1P1",
    count: 3,
    children: (
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full border border-black/50 font-bold text-white shadow-md ${COUNTER_COLORS.P1P1}`}
      >
        3
      </span>
    ),
  },
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByText("3"));
  },
} satisfies Meta<typeof CounterTooltip>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The counter every creature deals with, with its rules summary. */
export const PlusOnePlusOne: Story = {};

/** Counter types the engine knows by name keep their own colour and blurb. */
export const Stun: Story = {
  args: {
    type: "stun",
    count: 1,
    children: (
      <span className="flex h-7 w-7 items-center justify-center rounded-full border border-black/50 bg-purple-600 font-bold text-white shadow-md">
        1
      </span>
    ),
  },
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByText("1"));
  },
};

/**
 * CR 732.2a: a counter in an accepted growth loop is unbounded, so the pill
 * reads `∞` and the summary says so instead of leaking the still-finite count.
 */
export const Unbounded: Story = {
  args: {
    count: 2147483647,
    isUnbounded: true,
    children: (
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full border border-black/50 font-bold text-white shadow-md ${COUNTER_COLORS.P1P1}`}
      >
        ∞
      </span>
    ),
  },
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByText("∞"));
  },
};
