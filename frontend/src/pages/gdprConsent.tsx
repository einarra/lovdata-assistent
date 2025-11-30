import { useState } from 'react';
import './gdprConsent.css';

export interface GDPRConsentData {
  dataProcessing: boolean;
  dataStorage: boolean;
  dataSharing: boolean;
  marketing: boolean;
  consentDate: string;
  ipAddress?: string;
  userAgent?: string;
}

interface GDPRConsentFormProps {
  onSubmit: (data: GDPRConsentData) => Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
}

export function GDPRConsentForm({ onSubmit, onCancel, isLoading = false }: GDPRConsentFormProps) {
  const [dataProcessing, setDataProcessing] = useState(false);
  const [dataStorage, setDataStorage] = useState(false);
  const [dataSharing, setDataSharing] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    // GDPR requires explicit consent - all required fields must be checked
    if (!dataProcessing || !dataStorage) {
      setError('Du må godta behandling og lagring av data for å kunne bruke tjenesten.');
      return;
    }

    try {
      const consentData: GDPRConsentData = {
        dataProcessing,
        dataStorage,
        dataSharing,
        marketing,
        consentDate: new Date().toISOString(),
        ipAddress: undefined, // Will be captured on backend
        userAgent: navigator.userAgent,
      };

      await onSubmit(consentData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'En feil oppstod ved lagring av samtykke.');
    }
  };

  return (
    <div className="gdpr-consent-wrapper">
      <div className="gdpr-consent-card">
        <h2>Personvern og samtykke (GDPR)</h2>
        <p className="gdpr-intro">
          For å kunne bruke Lovdata Assistent må vi behandle og lagre noen personopplysninger. 
          Les gjennom informasjonen nedenfor og gi ditt samtykke.
        </p>

        <form onSubmit={handleSubmit} className="gdpr-form">
          <div className="gdpr-section">
            <h3>Hvilke data samler vi inn?</h3>
            <ul className="gdpr-list">
              <li>E-postadresse (for autentisering og kommunikasjon)</li>
              <li>Spørsmål du stiller (logges for debugging og feilsøking, ikke lagret i database)</li>
              <li>Teknisk informasjon (IP-adresse, nettlesertype, enhetsinformasjon)</li>
              <li>Abonnementsinformasjon (hvis du har aktivt abonnement)</li>
            </ul>
            <p className="gdpr-note">
              <strong>Viktig:</strong> Vi lagrer ikke chat-historikk eller søkehistorikk i vår database. 
              Spørsmål du stiller logges kun for operasjonelle formål (feilsøking og forbedring av tjenesten) 
              og sendes til OpenAI for behandling. Se vår personvernpolicy for mer informasjon om loggretensjon.
            </p>
          </div>

          <div className="gdpr-section">
            <h3>Hvorfor behandler vi dataene?</h3>
            <ul className="gdpr-list">
              <li>For å levere og forbedre tjenesten vår</li>
              <li>For å håndtere autentisering og sikkerhet</li>
              <li>For å oppfylle juridiske forpliktelser</li>
              <li>For å kommunisere med deg om tjenesten</li>
              <li>For feilsøking og operasjonell overvåking (spørsmål logges)</li>
            </ul>
            <p className="gdpr-note">
              <strong>Data deling med tredjeparter:</strong> Spørsmål du stiller sendes til OpenAI for 
              behandling og generering av svar. OpenAI kan beholde data i henhold til deres 
              personvernpolicy. Vi anbefaler at du gjennomgår OpenAI sine innstillinger for 
              databehandling hvis du har bekymringer.
            </p>
          </div>

          <div className="gdpr-section">
            <h3>Dine rettigheter</h3>
            <p>
              Du har rett til å få innsyn i, rette, slette eller begrense behandlingen av dine 
              personopplysninger. Du kan også klage til Datatilsynet hvis du mener behandlingen 
              er i strid med personvernregelverket.
            </p>
          </div>

          <div className="gdpr-consents">
            <div className="gdpr-consent-item required">
              <label className="gdpr-checkbox-label">
                <input
                  type="checkbox"
                  checked={dataProcessing}
                  onChange={(e) => setDataProcessing(e.target.checked)}
                  required
                  disabled={isLoading}
                />
                <span className="gdpr-checkbox-text">
                  <strong>Jeg samtykker til behandling av mine personopplysninger</strong>
                  <span className="gdpr-required-badge">Påkrevd</span>
                </span>
              </label>
              <p className="gdpr-consent-description">
                Dette er nødvendig for å kunne bruke tjenesten. Vi behandler dataene i henhold 
                til personvernregelverket (GDPR).
              </p>
            </div>

            <div className="gdpr-consent-item required">
              <label className="gdpr-checkbox-label">
                <input
                  type="checkbox"
                  checked={dataStorage}
                  onChange={(e) => setDataStorage(e.target.checked)}
                  required
                  disabled={isLoading}
                />
                <span className="gdpr-checkbox-text">
                  <strong>Jeg samtykker til lagring av mine personopplysninger</strong>
                  <span className="gdpr-required-badge">Påkrevd</span>
                </span>
              </label>
              <p className="gdpr-consent-description">
                Vi lagrer dataene dine på sikre servere i EU/EØS-området. Dataene lagres så 
                lenge du har en aktiv konto, eller inntil du ber om sletting.
              </p>
            </div>

            <div className="gdpr-consent-item">
              <label className="gdpr-checkbox-label">
                <input
                  type="checkbox"
                  checked={dataSharing}
                  onChange={(e) => setDataSharing(e.target.checked)}
                  disabled={isLoading}
                />
                <span className="gdpr-checkbox-text">
                  <strong>Jeg samtykker til deling av data med tredjeparter (valgfritt)</strong>
                </span>
              </label>
              <p className="gdpr-consent-description">
                Vi kan dele anonymiserte eller aggregerte data med tredjeparter for å forbedre 
                tjenesten. Dette inkluderer ikke personidentifiserbare opplysninger.
              </p>
            </div>

            <div className="gdpr-consent-item">
              <label className="gdpr-checkbox-label">
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(e) => setMarketing(e.target.checked)}
                  disabled={isLoading}
                />
                <span className="gdpr-checkbox-text">
                  <strong>Jeg samtykker til markedsføring og nyhetsbrev (valgfritt)</strong>
                </span>
              </label>
              <p className="gdpr-consent-description">
                Vi kan sende deg e-post om nye funksjoner, oppdateringer og relevante tilbud. 
                Du kan når som helst melde deg av.
              </p>
            </div>
          </div>

          {error && (
            <div className="gdpr-error">
              <p>{error}</p>
            </div>
          )}

          <div className="gdpr-actions">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="gdpr-button gdpr-button-secondary"
                disabled={isLoading}
              >
                Avbryt
              </button>
            )}
            <button
              type="submit"
              className="gdpr-button gdpr-button-primary"
              disabled={isLoading || !dataProcessing || !dataStorage}
            >
              {isLoading ? 'Lagrer...' : 'Godta og fortsett'}
            </button>
          </div>
        </form>

        <div className="gdpr-footer">
          <p>
            <strong>Kontakt oss:</strong> Hvis du har spørsmål om personvern, kan du kontakte oss på{' '}
            <a href="mailto:info@spektrallab.no">info@spektrallab.no</a>
          </p>
          <p className="gdpr-footer-note">
            Ved å gi samtykke bekrefter du at du har lest og forstått vår personvernpolicy og 
            samtykker til behandlingen av dine personopplysninger som beskrevet ovenfor.
          </p>
        </div>
      </div>
    </div>
  );
}

export default GDPRConsentForm;

