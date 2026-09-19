"use client";

// Failure toasts for optimistic mutations: the change is already rolled back
// by the time one shows, so all it has to do is say why. Bottom right, gone
// after five seconds or on click, announced to screen readers.

import { createContext, useCallback, useContext, useState } from "react";

type Toast = { id: number; message: string };

const ToastContext = createContext<(message: string) => void>(() => {});

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );
  const push = useCallback(
    (message: string) => {
      const id = ++nextId;
      setToasts((current) => [...current, { id, message }]);
      setTimeout(() => dismiss(id), 5_000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed right-4 bottom-4 z-50 flex flex-col gap-2"
      >
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            onClick={() => dismiss(toast.id)}
            className="max-w-sm rounded-tag border border-red-200 bg-white px-3 py-2 text-left text-xs text-red-800 shadow-md"
          >
            {toast.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string) => void {
  return useContext(ToastContext);
}
