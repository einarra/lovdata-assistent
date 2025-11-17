import './kontaktOss.css';

export function KontaktOss() {
  return (
    <div className="contact-wrapper">
      <section className="contact-section">
        <h2>Kontakt oss</h2>
        <p>
          Har du spørsmål om Lovdata Assistent, forslag til forbedringer eller ønsker om
          samarbeid? Vi hører gjerne fra deg. Ta kontakt direkte via e-post
          eller telefon.
        </p>
      </section>

      <section className="contact-section">
        <h3>Kontaktinformasjon</h3>
        <div className="contact-grid">
          <div className="contact-card">
            <h4>E-post</h4>
            <p>
              <a href="mailto:info@spektrallab.no">info@spektrallab.no</a>
            </p>
            <p className="contact-description">
              For tekniske spørsmål, tilbakemeldinger og supporthenvendelser.
            </p>
          </div>
          <div className="contact-card">
            <h4>Telefon</h4>
            <p>+47 95 79 42 19</p>
            <p className="contact-description">
              Åpningstid: mandag–fredag 08.30–15.30.
            </p>
          </div>
        </div>
      </section>

      {/* Kontaktforespørsler via skjema er midlertidig deaktivert */}
      {/* <section className="contact-section">
        <h3>Send oss en melding</h3>
        <form className="contact-form" onSubmit={(event) => event.preventDefault()}>
          <div className="form-group">
            <label htmlFor="name">Navn</label>
            <input id="name" name="name" type="text" placeholder="Ditt navn" required />
          </div>
          <div className="form-group">
            <label htmlFor="email">E-post</label>
            <input id="email" name="email" type="email" placeholder="din@epost.no" required />
          </div>
          <div className="form-group">
            <label htmlFor="category">Kategori</label>
            <select id="category" name="category" defaultValue="generelt">
              <option value="generelt">Generelle spørsmål</option>
              <option value="teknisk">Teknisk problem</option>
              <option value="samarbeid">Samarbeid og partnerskap</option>
              <option value="annet">Annet</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="message">Melding</label>
            <textarea
              id="message"
              name="message"
              rows={6}
              placeholder="Fortell oss hva vi kan hjelpe deg med..."
              required
            />
          </div>
          <button type="submit" className="contact-submit" disabled>
            Send (kommer snart)
          </button>
        </form>
      </section> */}
    </div>
  );
}

export default KontaktOss;
