import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/layout";
import CreateEventPage from "./pages/create-event";
import DoorPage from "./pages/door";
import EventDetailPage from "./pages/event-detail";
import EventsPage from "./pages/events";
import WalletPage from "./pages/wallet";
import { WalletProvider } from "./wallet/provider";

export default function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<EventsPage />} />
            <Route path="create" element={<CreateEventPage />} />
            <Route path="events/:covenantId" element={<EventDetailPage />} />
            <Route path="tickets" element={<WalletPage />} />
          </Route>
          <Route path="door" element={<DoorPage />} />
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  );
}
