import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CreateEventDialog } from "./create-event-dialog";

interface CreateDialogContextValue {
  openCreate: () => void;
}

const CreateDialogContext = createContext<CreateDialogContextValue | null>(null);

export function CreateDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const openCreate = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <CreateDialogContext.Provider value={{ openCreate }}>
      {children}
      {open && <CreateEventDialog onClose={close} />}
    </CreateDialogContext.Provider>
  );
}

export function useCreateDialog(): CreateDialogContextValue {
  const ctx = useContext(CreateDialogContext);
  if (!ctx) {
    throw new Error("useCreateDialog must be used within a CreateDialogProvider");
  }
  return ctx;
}
