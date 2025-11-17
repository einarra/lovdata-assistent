import './omOss.css';

export function OmOss() {
  return (
    <div className="about-wrapper">
      <section className="about-section">
        <h2>Om Lovdata Assistent</h2>
        <p>
          Lovdata Assistent er en digital veileder som gjør det enklere å finne frem i norske
          lover, forskrifter og andre rettskilder. Løsningen er bygget for å støtte både
          profesjonelle brukere og privatpersoner som ønsker rask tilgang til pålitelig juridisk
          informasjon.
        </p>
        <p>
          Assistenten benytter Lovdata sitt offentlige API og kombinerer dette med moderne
          språkmodeller. Vi legger vekt på transparens, kildehenvisninger og sikker behandling av
          data. All kommunikasjon er kryptert, og vi lagrer ikke spørsmålene dine utover det som er
          nødvendig for å forbedre tjenesten.
        </p>
        <p>
          Målet vårt er å gjøre norsk rett mer tilgjengelig, og samtidig ivareta Lovdata sine
          kvalitetstandarder. Vi arbeider kontinuerlig med å forbedre søk, dokumentlesing og
          brukeropplevelse.
        </p>
      </section>

      <section className="about-section">
        <h3>Hva kan du gjøre her?</h3>
        <ul>
          <li>Søke i tilgjengelige lov- og forskriftsarkiv</li>
          <li>Få sammendrag og forklaringer på juridiske begreper og bestemmelser</li>
          <li>Hente ut og lese dokumenter direkte i løsningen</li>
          <li>Følge lovendringer og holde deg oppdatert</li>
        </ul>
      </section>

      <section className="about-section">
        <h3>Veien videre</h3>
        <p>
          Vi jobber med flere nye funksjoner, blant annet tema-sider, favorittlister.
          Har du innspill eller ønsker? Ta gjerne kontakt med oss fra menyen
          øverst til høyre.
        </p>
      </section>
    </div>
  );
}

export default OmOss;
