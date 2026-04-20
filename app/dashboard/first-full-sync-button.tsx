"use client";

import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-[#1f1711] px-5 py-3 text-sm font-semibold text-[#f9f2e7] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
    >
      {pending ? "Running first full sync..." : "Run first full sync now"}
    </button>
  );
}

export function FirstFullSyncButton(props: {
  action: () => Promise<void>;
}) {
  return (
    <form action={props.action} className="mt-4 space-y-3">
      <SubmitButton />
      <p className="text-xs leading-6 text-muted">
        This can take a few minutes. The page will update after the run
        finishes.
      </p>
    </form>
  );
}
