import type { ReactNode } from "react";

interface EmptyProps {
  children: ReactNode;
}

export const Empty = ({ children }: EmptyProps) => (
  <div style={{
    background: "white",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: "48px 24px",
    textAlign: "center",
  }}>
    {children}
  </div>
);
