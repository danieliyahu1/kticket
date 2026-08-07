import { network } from "./network";

export default function App() {
  return (
    <main>
      <h1>kticket</h1>
      <p>
        Web SPA shell — active network: {network.net} ({network.label})
      </p>
    </main>
  );
}
