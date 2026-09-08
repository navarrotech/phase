import type { Meta, StoryObj } from "@storybook/react-vite";

import { SelectField } from "./SelectField.tsx";

/**
 * The app's native `<select>`, with the browser chevron replaced by one that
 * inherits the dark theme. Keeping the native element means keyboard and
 * mobile pickers stay the platform's own.
 */
const meta = {
  title: "UI/SelectField",
  component: SelectField,
  args: {
    defaultValue: "commander",
    className: "w-56 rounded-md border border-white/15 bg-slate-950/70 px-3 py-2 text-sm text-white",
    children: (
      <>
        <option value="standard">Standard</option>
        <option value="commander">Commander</option>
        <option value="modern">Modern</option>
        <option value="legacy">Legacy</option>
      </>
    ),
  },
  argTypes: {
    chevronSize: { control: "inline-radio", options: ["sm", "md"] },
  },
} satisfies Meta<typeof SelectField>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The form preset: a roomier chevron with matching right padding. */
export const Medium: Story = {
  args: { chevronSize: "md" },
};

/** The compact preset, for toolbars where the row height is fixed. */
export const Small: Story = {
  args: {
    chevronSize: "sm",
    className: "w-40 rounded-md border border-white/15 bg-slate-950/70 px-2 py-1 text-xs text-white",
  },
};

/** Disabling the select dims the chevron with it, so the two never disagree. */
export const Disabled: Story = {
  args: { disabled: true },
};
