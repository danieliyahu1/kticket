import type { ReactNode } from "react";
import { useWallet } from "../hooks/use-wallet";
import { useAuth } from "../auth/AuthProvider";
import { Empty } from "./empty";

interface AuthGateProps {
  /** Copy for the not-connected state, which differs per page. */
  connectTitle: string;
  connectSub: string;
  children: ReactNode;
}

/**
 * Gates a user-specific page on the wallet-identity session:
 *   not connected   -> connect prompt
 *   signing in      -> spinner
 *   canceled/failed -> message + retry (never an endless spinner)
 *   ready           -> the page content
 *
 * A canceled Kasware sign-in lands in the error branch, so the user always sees
 * why the page stopped and can retry without a reload.
 */
export function AuthGate({ connectTitle, connectSub, children }: AuthGateProps) {
  const { state, connect } = useWallet();
  const auth = useAuth();

  if (state.status !== "connected") {
    return (
      <Empty
        title={connectTitle}
        sub={connectSub}
        actionLabel="Connect wallet"
        onAction={connect}
      />
    );
  }

  if (auth.status === "error") {
    return (
      <Empty
        title="Sign-in didn't complete."
        sub={auth.error ?? "Please try again."}
        actionLabel="Retry sign-in"
        onAction={() => void auth.signIn({ force: true })}
      />
    );
  }

  if (auth.status !== "ready") {
    return (
      <div className="checkin-status" role="status">
        <div className="spinner spinner-sm" />
        <span>Signing you in…</span>
      </div>
    );
  }

  return <>{children}</>;
}
