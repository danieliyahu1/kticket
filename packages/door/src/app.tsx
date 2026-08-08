import { network } from "./network";

export default function App() {
  return (
    <div className="door">
      <header className="door-header">
        <span className="door-wordmark">kticket</span>
        <span className="door-badge">Door</span>
      </header>
      <main className="door-main">
        <div className="door-status">
          <span className="door-status-dot" aria-hidden="true" />
          Standing by
        </div>
        <h1 className="door-title">The door is ready.</h1>
        <p className="door-sub">Scan a ticket and the door opens. Anyone who holds one gets in.</p>
        <div className="door-frame">Waiting for a ticket</div>
      </main>
      <footer className="door-foot">On {network.label}</footer>
    </div>
  );
}
