import { createBrowserRouter, Navigate } from 'react-router'
import { AppError } from './components/AppError.tsx'
import { Layout } from './components/Layout.tsx'
import { useClient } from './lib/client.ts'
import { BrainstormPage } from './pages/BrainstormPage.tsx'
import { DeckEditorPage } from './pages/DeckEditorPage.tsx'
import { DecksPage } from './pages/DecksPage.tsx'
import { LibraryPage } from './pages/LibraryPage.tsx'
import { PlaytestPage } from './pages/PlaytestPage.tsx'
import { ScanPage } from './pages/ScanPage.tsx'
import { SearchPage } from './pages/SearchPage.tsx'
import { SetPage } from './pages/SetPage.tsx'
import { SetsPage } from './pages/SetsPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'

/**
 * The pairing page's address, for the app: a phone that isn't paired is shown the pairing page by ClientGate wherever
 * it is. This computer needs no pairing, and goes to where phones are paired; a paired phone goes to its library.
 */
function PairRoute() {
  return useClient().kind === 'pc' ? <Navigate to="/settings#phone-access" replace /> : <Navigate to="/library" replace />
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    errorElement: <AppError />,
    children: [
      // Binder opens on Library (spec §5.7): Binder.app's first page, and old links to Look up, land there.
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'sets', element: <SetsPage /> },
      { path: 'sets/:code', element: <SetPage /> },
      { path: 'scan', element: <ScanPage /> },
      { path: 'decks', element: <DecksPage /> },
      { path: 'decks/:id', element: <DeckEditorPage /> },
      { path: 'playtest', element: <PlaytestPage /> },
      { path: 'brainstorm', element: <BrainstormPage /> },
      { path: 'brainstorm/:threadId', element: <BrainstormPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'pair', element: <PairRoute /> },
    ],
  },
])
