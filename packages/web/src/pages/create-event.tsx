import { useState } from "react";
import { Link } from "react-router-dom";
import { type DeployParams, type DeployState, executeDeploy } from "../api/deploy-machine";
import { DeployDialog, DeployStatus } from "../components/deploy-dialog";
import { EventForm, type EventFormData } from "../components/event-form";
import { validate } from "../components/event-validate";
import { Review } from "../components/review";
import { useWallet } from "../hooks/use-wallet";

type ConnectedWallet = { publicKey: string; accounts: string[] };
type Step = "form" | "review" | "confirm";

const EMPTY_FORM: EventFormData = { name: "", date: "", time: "", capacity: 0, price: 0 };

const STEP_LABELS: Record<Step, string> = {
  form: "Step 1 of 3 · Details",
  review: "Step 2 of 3 · Review",
  confirm: "Step 3 of 3 · Confirm",
};

export default function CreateEventPage() {
  const { state } = useWallet();
  if (state.status !== "connected") return <RequireWallet />;
  return <CreateForm wallet={state} />;
}

function RequireWallet() {
  return (
    <section>
      <PageHeader caption="Step 1 of 3 · Details" title="Create an event" />
      <div className="empty">
        <p className="empty-title">Connect your wallet to create an event.</p>
        <p className="empty-sub">Events are put on Kaspa from your own wallet.</p>
        <div className="empty-actions">
          <Link to="/" className="btn btn-primary">
            Connect wallet
          </Link>
        </div>
      </div>
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
  const [step, setStep] = useState<Step>("form");
  const [form, setForm] = useState<EventFormData>(EMPTY_FORM);
  const [deploy, setDeploy] = useState<DeployState>({ phase: "idle" });
  const [errors, setErrors] = useState<Partial<Record<keyof EventFormData, string>>>({});

  const startDeploy = () => deployEvent(wallet, form, setDeploy);

  if (deploy.phase !== "idle") {
    return <DeployResult deploy={deploy} onRetry={startDeploy} />;
  }
  if (step === "confirm") {
    return (
      <section>
        <PageHeader caption="Step 3 of 3 · Confirm" title="Create an event" />
        <DeployDialog
          eventName={form.name}
          onConfirm={startDeploy}
          onCancel={() => setStep("review")}
        />
      </section>
    );
  }
  if (step === "review") {
    return (
      <section>
        <PageHeader caption="Step 2 of 3 · Review" title="Create an event" />
        <Review data={form} onDeploy={() => setStep("confirm")} onEdit={() => setStep("form")} />
      </section>
    );
  }
  return (
    <section>
      <PageHeader caption={STEP_LABELS.form} title="Create an event" />
      <EventForm
        initial={form}
        onSubmit={(data) => submitForm(data, setErrors, setStep)}
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
  };
  executeDeploy(setDeploy, params);
}

function submitForm(
  data: EventFormData,
  setErrors: (e: Partial<Record<keyof EventFormData, string>>) => void,
  setStep: (s: Step) => void,
) {
  const errs = validate(data);
  if (Object.keys(errs).length > 0) {
    setErrors(errs);
    return;
  }
  setErrors({});
  setStep("review");
}

function deployPhaseStatus(
  phase: DeployState["phase"],
): "deploying" | "broadcasting" | "success" | "error" {
  if (phase === "building") return "deploying";
  if (phase === "broadcasting") return "broadcasting";
  if (phase === "success") return "success";
  return "error";
}

function DeployResult({ deploy, onRetry }: { deploy: DeployState; onRetry: () => void }) {
  if (deploy.phase === "idle") return null;
  return (
    <section>
      <PageHeader caption="Step 3 of 3 · Deploying" title="Create an event" />
      <DeployStatus
        status={deployPhaseStatus(deploy.phase)}
        error={deploy.phase === "error" ? deploy.message : undefined}
        txid={deploy.phase === "success" ? deploy.txid : undefined}
        onRetry={onRetry}
      />
    </section>
  );
}
