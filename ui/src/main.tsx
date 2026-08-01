import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"
import { ThemeProvider } from "@/lib/theme"
import { ConfirmProvider } from "@/components/confirm-dialog"
import { ConnectionProvider } from "@/providers/context"
import { App } from "@/app"
import "./index.css"

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConnectionProvider>
          <ConfirmProvider>
            <App />
            <Toaster position="bottom-right" theme="system" />
          </ConfirmProvider>
        </ConnectionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
