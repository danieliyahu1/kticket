/**
 * The first thing a visitor reads on the home page (issue #8): what kticket is
 * in one breath, why a ticket on the chain is worth having, and the fact that
 * looking around costs nothing. It asks for nothing.
 */
export function HomeIntro() {
  return (
    <section className="home-intro" aria-labelledby="home-intro-title">
      <h1 id="home-intro-title" className="home-intro-title">
        Tickets on the chain.
      </h1>
      <p className="home-intro-lead">
        Create an event. Sell tickets in KAS. Anyone holding a ticket gets in.
      </p>
      <p className="home-intro-trust">
        Tickets live on Kaspa — so they can&apos;t be copied, and the door can&apos;t be fooled.
      </p>
      <p className="home-intro-reassurance">Looking around needs no wallet.</p>
    </section>
  );
}
