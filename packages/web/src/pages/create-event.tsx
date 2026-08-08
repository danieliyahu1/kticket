import { useState } from "react";
import { type DeployParams, type DeployState, executeDeploy } from "../api/deploy-machine";
import { DeployDialog, DeployStatus } from "../components/deploy-dialog";
import { EventForm, type EventFormData } from "../components/event-form";
import { validate } from "../components/event-validate";
import { Review } from "../components/review";
import { useWallet } from "../hooks/use-wallet";

type ConnectedWallet = { publicKey: string; accounts: string[] };

const EMPTY_FORM: EventFormData = { name: "", date: "", time: "", capacity: 0, price: 0 };

export default function CreateEventPage() {
  const { state } = useWallet();
  if (state.status !== "connected") {
    return <p>Connect your wallet to create an event.</p>;
  }
  return <CreateForm wallet={state} />;
}

function CreateForm({ wallet }: { wallet: ConnectedWallet }) {
  const [step, setStep] = useState<"form" | "review" | "confirm">("form");
  const [form, setForm] = useState<EventFormData>(EMPTY_FORM);
  const [deploy, setDeploy] = useState<DeployState>({ phase: "idle" });
  const [errors, setErrors] = useState<Partial<Record<keyof EventFormData, string>>>({});

  if (deploy.phase !== "idle") return <DeployResult deploy={deploy} />;

  if (step === "confirm") {
    return (
      <DeployDialog
        eventName={form.name}
        onConfirm={() => {
          startDeploy(setDeploy, {
            capacity: form.capacity,
            priceKas: form.price,
            publicKey: wallet.publicKey,
            address: wallet.accounts[0] ?? "",
          });
        }}
        onCancel={() => setStep("review")}
      />
    );
  }
  if (step === "review") {
    return (
      <Review data={form} onDeploy={() => setStep("confirm")} onEdit={() => setStep("form")} />
    );
  }
  return (
    <EventForm
      initial={form}
      onSubmit={(data) => handleFormSubmit(data, setErrors, setStep)}
      errors={errors}
      onChange={setForm}
    />
  );
}

function handleFormSubmit(
  data: EventFormData,
  setErrors: (e: Partial<Record<keyof EventFormData, string>>) => void,
  setStep: (s: "form" | "review" | "confirm") => void,
) {
  const errs = validate(data);
  if (Object.keys(errs).length > 0) {
    setErrors(errs);
    return;
  }
  setErrors({});
  setStep("review");
}

function startDeploy(setDeploy: (s: DeployState) => void, params: DeployParams) {
  executeDeploy(setDeploy, params);
}

function deployPhaseStatus(
  phase: DeployState["phase"],
): "deploying" | "broadcasting" | "success" | "error" {
  if (phase === "building") return "deploying";
  if (phase === "broadcasting") return "broadcasting";
  if (phase === "success") return "success";
  return "error";
}

function DeployResult({ deploy }: { deploy: DeployState }) {
  if (deploy.phase === "idle") return null;
  return (
    <DeployStatus
      status={deployPhaseStatus(deploy.phase)}
      error={deploy.phase === "error" ? deploy.message : undefined}
      txid={deploy.phase === "success" ? deploy.txid : undefined}
    />
  );
}
