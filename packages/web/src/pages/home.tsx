import { useWallet } from "../hooks/use-wallet";
import { network } from "../network";

export default function HomePage() {
  const { state } = useWallet();

  if (state.status === "connected") {
    return (
      <section>
        <h2>Welcome</h2>
        <p>
          Connected: {state.accounts[0]} on {network.label}
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>kticket</h2>
      <p>
        On-chain event ticketing on {network.label}. Connect your Kasware wallet to get started.
      </p>
    </section>
  );
}
