import Link from "next/link";
import { env } from "@/lib/env";
import {
  isOperatorAuthConfigured,
  isOperatorAuthenticated,
} from "@/lib/operator-auth";
import { loginAction } from "@/app/login/actions";
import { redirect } from "next/navigation";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
) {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

export const dynamic = "force-dynamic";

export default async function LoginPage(props: LoginPageProps) {
  if (await isOperatorAuthenticated()) {
    redirect("/dashboard");
  }

  const searchParams = props.searchParams ? await props.searchParams : {};
  const hasError = getSearchParam(searchParams, "error") === "invalid";
  const configured = isOperatorAuthConfigured();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center px-6 py-10 md:px-10">
      <div className="grid w-full gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="glass-panel rounded-[2rem] p-8 md:p-10">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent-strong">
            Operator Access
          </p>
          <h1 className="mt-4 text-5xl font-semibold tracking-[-0.05em] text-foreground md:text-6xl">
            DPP feed control room
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-muted md:text-lg">
            Shared operator login for feed previews, cadence settings, and sync
            history. Shopify is already connected. Google writes are still
            disabled.
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <div className="rounded-[1.4rem] border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Delta syncs
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                Weekly
              </p>
            </div>
            <div className="rounded-[1.4rem] border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Full refresh
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em]">
                15-day guardrail
              </p>
            </div>
            <div className="rounded-[1.4rem] border border-line bg-white/65 p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted">
                Store
              </p>
              <p className="mt-3 text-lg font-semibold tracking-[-0.04em]">
                {env.shopifyStoreDomain || "Not configured"}
              </p>
            </div>
          </div>
        </section>

        <section className="glass-panel rounded-[2rem] p-8 md:p-10">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted">
            Sign In
          </p>

          {!configured ? (
            <div className="mt-6 rounded-[1.4rem] border border-[rgba(143,54,0,0.2)] bg-[#fff2e6] p-5 text-sm leading-7 text-[#69320d]">
              <p>
                Set <code>DASHBOARD_PASSWORD</code> in Vercel to enable the
                shared operator login.
              </p>
              <p className="mt-3">
                Recommended: also set <code>DASHBOARD_SESSION_SECRET</code>.
                If you leave it blank, the app falls back to your Shopify
                client secret for session signing.
              </p>
            </div>
          ) : (
            <form action={loginAction} className="mt-6 grid gap-4">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  Shared password
                </span>
                <input
                  name="password"
                  type="password"
                  required
                  className="rounded-2xl border border-line bg-white/80 px-4 py-3 text-base outline-none transition-shadow focus:shadow-[0_0_0_4px_rgba(197,92,22,0.12)]"
                  placeholder="Enter operator password"
                />
              </label>

              {hasError ? (
                <p className="rounded-2xl border border-[rgba(143,54,0,0.18)] bg-[#fff2e6] px-4 py-3 text-sm text-[#7d3d10]">
                  Password was not accepted.
                </p>
              ) : null}

              <button
                type="submit"
                className="rounded-full bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5"
              >
                Enter dashboard
              </button>
            </form>
          )}

          <div className="mt-8 grid gap-3 text-sm leading-7 text-muted">
            <p>
              The operator dashboard controls cadence settings and preview-only
              validation. No Google Merchant updates run from the UI yet.
            </p>
            <p>
              Technical setup and raw integration routes are still available at{" "}
              <Link href="/setup" className="font-semibold text-accent-strong">
                /setup
              </Link>
              .
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
