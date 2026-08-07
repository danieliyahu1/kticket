import { network } from "./network";

export default function App() {
  return (
    <main>
      <h1>kticket Door</h1>
      <p>
        Door client shell — active network: {network.net} ({network.label})
      </p>
    </main>
  );
}
