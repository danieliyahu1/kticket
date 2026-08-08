import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/layout";
import CreateEventPage from "./pages/create-event";
import EventsPage from "./pages/events";
import HomePage from "./pages/home";
import { WalletProvider } from "./wallet/provider";

export default function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="create" element={<CreateEventPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  );
}
