import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import './index.css'
import { ApiRequestError } from './lib/api.ts'
import { CardDrawerProvider } from './lib/card-drawer.tsx'
import { ToastProvider } from './lib/toast.tsx'
import { router } from './routes.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Once more when the server couldn't be reached or failed; a 4xx is its answer, which asking again won't change.
      retry: (failures, err) => failures < 1 && !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500),
      // When the page shows again (a phone woken, a tab come back to), what's on it is fetched again once it's older
      // than staleTime: the library or a deck may have changed on the computer meanwhile.
      refetchOnWindowFocus: true,
    },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <CardDrawerProvider>
          <RouterProvider router={router} />
        </CardDrawerProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
