import { BrowserRouter, Route, Routes } from "react-router-dom";
import { CreateDialogProvider } from "./components/create-dialog-context";
import { Layout } from "./components/layout";
import EventDetailPage from "./pages/event-detail";
import EventsPage from "./pages/events";
import GatePage from "./pages/gate";
import MarketplacePage from "./pages/marketplace";
import MyEventsPage from "./pages/my-events";
import TicketsPage from "./pages/tickets";
import { WalletProvider } from "./wallet/provider";

export default function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <CreateDialogProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<EventsPage />} />
              <Route path="marketplace" element={<MarketplacePage />} />
              <Route path="tickets" element={<TicketsPage />} />
              <Route path="my-events" element={<MyEventsPage />} />
              <Route path="events/:covenantId" element={<EventDetailPage />} />
              <Route path="gate/:covenantId" element={<GatePage />} />
            </Route>
          </Routes>
        </CreateDialogProvider>
      </BrowserRouter>
    </WalletProvider>
  );
}
