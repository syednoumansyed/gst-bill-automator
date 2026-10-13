"use client";

import { ConfigForm } from "../settings/_components/config-form";

// First-run setup: the settings form, numbered, saving straight back to the generator
export default function Setup() {
  return <ConfigForm mode="setup" />;
}
