import { useState } from "react";
import { type DeployParams, type DeployState, executeDeploy } from "../api/deploy-machine";
import { DeployStatus } from "../components/deploy-dialog";
import { Empty } from "../components/empty";
import { EventForm, type EventFormData } from "../components/event-form";
import { validate } from "../components/event-validate";
import { useWallet } from "../hooks/use-wallet";

type ConnectedWallet = { publicKey: string; accounts: string[] };

const EMPTY_FORM: EventFormData = { name: "", date: "", time: "", capacity: 0, price: 0 };

export default function CreateEventPage() {
  const { state } = useWallet();
  if (state.status !== "connected") return <RequireWallet />;
  return <CreateForm wallet={state} />;
}

function RequireWallet() {
  const { connect } = useWallet();
  return (
    <section>
      <PageHeader caption="Step 1 of 2 · Details" title="Create an event" />
      <Empty
        title="Connect your wallet to create an event."
        sub="Events are put on Kaspa from your own wallet."
        actionLabel="Connect wallet"
        onAction={connect}
      />
    </section>
  );
}

function PageHeader({ caption, title }: { caption: string; title: string }) {
  return (
    <header>
      <p className="step">{caption}</p>
      <h2 className="page-heading">{title}</h2>
    </header>
  );
}

function CreateForm({ wallet }: { wallet: ConnectedWallet }) {
  const [form, setForm] = useState<EventFormData>(EMPTY_FORM);
  const [deploy, setDeploy] = useState<DeployState>({ phase: "idle" });
  const [errors, setErrors] = useState<Partial<Record<keyof EventFormData, string>>>({});

  const startDeploy = () => deployEvent(wallet, form, setDeploy);

  if (deploy.phase !== "idle") {
    return (
      <section key="deploy" className="step-enter">
        <PageHeader caption="Step 2 of 2 · Deploying" title="Create an event" />
        <DeployResult deploy={deploy} onRetry={startDeploy} />
      </section>
    );
  }

  return (
    <section key="form" className="step-enter">
      <PageHeader caption="Step 1 of 2 · Details" title="Create an event" />
      <EventForm
        initial={form}
        onSubmit={(data) => {
          const errs = validate(data);
          if (Object.keys(errs).length > 0) {
            setErrors(errs);
            return;
          }
          setErrors({});
          startDeploy();
        }}
        errors={errors}
        onChange={setForm}
      />
    </section>
  );
}

function deployEvent(
  wallet: ConnectedWallet,
  form: EventFormData,
  setDeploy: (s: DeployState) => void,
) {
  const params: DeployParams = {
    capacity: form.capacity,
    priceKas: form.price,
    publicKey: wallet.publicKey,
    address: wallet.accounts[0] ?? "",
    name: form.name,
    date: form.date,
  };
  executeDeploy(setDeploy, params);
}

function deployPhaseStatus(
  phase: DeployState["phase"],
): "deploying" | "broadcasting" | "success" | "error" {
  if (phase === "building") return "deploying";
  if (phase === "signing" || phase === "broadcasting") return "broadcasting";
  if (phase === "success") return "success";
  return "error";
}

function DeployResult({ deploy, onRetry }: { deploy: DeployState; onRetry: () => void }) {
  if (deploy.phase === "idle") return null;
  return (
    <DeployStatus
      status={deployPhaseStatus(deploy.phase)}
      error={deploy.phase === "error" ? deploy.message : undefined}
      txid={deploy.phase === "success" ? deploy.txid : undefined}
      onRetry={onRetry}
    />
  );
}
