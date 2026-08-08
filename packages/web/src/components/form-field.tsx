import type { ComponentProps } from "react";

interface FormFieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}

export function FormField({ id, label, error, hint, children }: FormFieldProps) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
      {error && <small>{error}</small>}
    </div>
  );
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} />;
}
