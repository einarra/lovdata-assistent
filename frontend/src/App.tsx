import { useState, useEffect, useCallback } from 'react';
import { ChatWindow } from './components/ChatWindow';
import { ChatInput } from './components/ChatInput';
import type { Message } from './types/chat';
import { apiService, type AssistantRunResponse, type SessionInfo } from './services/api';
import { OmOss } from './pages/omOss';
import { KontaktOss } from './pages/kontaktOss';
import { GDPRConsentForm, type GDPRConsentData } from './pages/gdprConsent';
import './App.css';
import { supabase } from './lib/supabaseClient';
import { useSupabaseSession } from './hooks/useSupabaseSession';
import { Analytics } from '@vercel/analytics/react';

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'chat' | 'about' | 'contact'>('chat');
  const { session, loading: sessionLoading, configured: supabaseReady, authEvent, clearAuthEvent } =
    useSupabaseSession();
  const [authEmail, setAuthEmail] = useState('');
  const [authMode, setAuthMode] = useState<'magic' | 'password'>('magic');
  const [password, setPassword] = useState('');
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [profile, setProfile] = useState<SessionInfo | null>(null);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordResetStatus, setPasswordResetStatus] = useState<string | null>(null);
  const [hasGDPRConsent, setHasGDPRConsent] = useState<boolean | null>(null);
  const [checkingConsent, setCheckingConsent] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

  const checkHealth = useCallback(async () => {
    try {
      await apiService.healthCheck();
      setError(null);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Kunne ikke nå backendens /health-endepunkt.';
      setError(errorMessage);
      console.error('Health check failed:', err);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    if (!error) return;
    const intervalId = window.setInterval(() => {
      void checkHealth();
    }, 5000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [error, checkHealth]);

  const accessToken = session?.access_token ?? null;

  useEffect(() => {
    if (authEvent === 'PASSWORD_RECOVERY') {
      setShowPasswordReset(true);
      setAuthMode('password');
      setPasswordResetStatus('Velg et nytt passord for kontoen din.');
    }
  }, [authEvent]);

  useEffect(() => {
    let cancelled = false;
    if (!accessToken) {
      setProfile(null);
      setHasGDPRConsent(null);
      return;
    }
    apiService
      .fetchSession(accessToken)
      .then((data) => {
        if (!cancelled) {
          setProfile(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfile(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // Check GDPR consent when user is logged in
  useEffect(() => {
    let cancelled = false;
    if (!accessToken) {
      setHasGDPRConsent(null);
      return;
    }

    setCheckingConsent(true);
    apiService
      .fetchGDPRConsent(accessToken)
      .then((response) => {
        if (!cancelled) {
          setHasGDPRConsent(response.consent !== null);
          setCheckingConsent(false);
        }
      })
      .catch((err) => {
        console.error('Failed to check GDPR consent:', err);
        if (!cancelled) {
          // If error, assume no consent to be safe
          setHasGDPRConsent(false);
          setCheckingConsent(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const handleSendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) {
        return;
      }
      if (!accessToken) {
        setError('Du må være innlogget for å sende meldinger.');
        return;
      }

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      setError(null);

      try {
        // Ensure we have a fresh token before making the request
        let token = accessToken;
        if (supabase && session) {
          // Refresh session to get latest token
          const { data: { session: freshSession } } = await supabase.auth.getSession();
          token = freshSession?.access_token ?? accessToken;
        }
        
        if (!token) {
          throw new Error('Du må være innlogget for å sende meldinger.');
        }

        const response = await apiService.assistantRun({ question: trimmed }, token);
        const assistantMessage: Message = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: response.answer,
          timestamp: new Date(),
          data: response as AssistantRunResponse,
        };

        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Kunne ikke få svar fra assistenten';
        setError(message);

        const errorMessageObj: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `Beklager, jeg oppdaget en feil: ${message}. Vennligst prøv igjen.`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessageObj]);
      } finally {
        setIsLoading(false);
      }
    },
    [accessToken, session, supabase],
  );

  if (!supabaseReady) {
    return (
      <div className="app">
        <main className="app-main">
          <div className="auth-card">
            <h2>Konfigurasjon mangler</h2>
            <p>
              Supabase-variablene er ikke satt. Legg til <code>VITE_SUPABASE_URL</code> og{' '}
              <code>VITE_SUPABASE_ANON_KEY</code> i <code>frontend/.env</code> og start dev-serveren på nytt.
            </p>
          </div>
        </main>
      </div>
    );
  }

  if (sessionLoading || (session && checkingConsent)) {
    return (
      <div className="app">
        <main className="app-main">
          <div className="loading-state">
            <p>Laster inn …</p>
          </div>
        </main>
      </div>
    );
  }

  const handleMagicLinkLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthStatus(null);
    if (!authEmail) {
      setAuthStatus('Skriv inn en gyldig e-postadresse.');
      return;
    }
    if (!supabase) {
      setAuthStatus('Supabase er ikke konfigurert.');
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({
      email: authEmail,
      options: {
        emailRedirectTo: window.location.origin
      }
    });
    if (error) {
      setAuthStatus(error.message);
      return;
    }
    setAuthStatus('Vi har sendt deg en innloggingslenke på e-post. Sjekk innboksen din.');
  };

  const handlePasswordLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthStatus(null);
    if (!authEmail) {
      setAuthStatus('Skriv inn en gyldig e-postadresse.');
      return;
    }
    if (!password) {
      setAuthStatus('Skriv inn passordet ditt.');
      return;
    }
    if (!supabase) {
      setAuthStatus('Supabase er ikke konfigurert.');
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password
    });
    if (error) {
      setAuthStatus(error.message);
      return;
    }
    setPassword('');
    setAuthStatus('Pålogging vellykket!');
  };

  const handlePasswordReset = async () => {
    setAuthStatus(null);
    if (!authEmail) {
      setAuthStatus('Skriv inn e-postadressen din før du ber om tilbakestilling.');
      return;
    }
    if (!supabase) {
      setAuthStatus('Supabase er ikke konfigurert.');
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(authEmail, {
      redirectTo: window.location.origin
    });
    if (error) {
      setAuthStatus(error.message);
      return;
    }
    setAuthStatus('Vi har sendt deg en e-post for å tilbakestille passordet.');
  };

  const handlePasswordUpdate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordResetStatus(null);
    if (!newPassword) {
      setPasswordResetStatus('Skriv inn et nytt passord.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordResetStatus('Passordene må være like.');
      return;
    }
    if (!supabase) {
      setPasswordResetStatus('Supabase er ikke konfigurert.');
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setPasswordResetStatus(error.message);
      return;
    }
    setPasswordResetStatus('Passordet er oppdatert. Du er nå innlogget.');
    setNewPassword('');
    setConfirmPassword('');
    setShowPasswordReset(false);
    clearAuthEvent();
  };

  const handleSignOut = async () => {
    if (!supabase) {
      return;
    }
    await supabase.auth.signOut();
    setProfile(null);
    setHasGDPRConsent(null);
  };

  const handleGDPRConsentSubmit = async (data: GDPRConsentData) => {
    if (!accessToken) {
      throw new Error('Du må være innlogget for å gi samtykke.');
    }

    setSavingConsent(true);
    try {
      await apiService.saveGDPRConsent(
        {
          dataProcessing: data.dataProcessing,
          dataStorage: data.dataStorage,
          dataSharing: data.dataSharing,
          marketing: data.marketing,
          consentDate: data.consentDate,
          userAgent: data.userAgent,
        },
        accessToken
      );
      setHasGDPRConsent(true);
    } finally {
      setSavingConsent(false);
    }
  };

  if (showPasswordReset) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="header-content">
            <div className="header-info">
              <h1>Lovdata Assistent</h1>
              <p>Velg et nytt passord for å fortsette.</p>
            </div>
          </div>
        </header>
        <main className="app-main">
          <div className="auth-card">
            <h2>Tilbakestill passord</h2>
            <p>Angi et nytt passord for kontoen din.</p>
            <form onSubmit={handlePasswordUpdate} className="auth-form">
              <label htmlFor="new-password">Nytt passord</label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="********"
                required
              />
              <label htmlFor="confirm-password">Bekreft passord</label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="********"
                required
              />
              <button type="submit">Oppdater passord</button>
            </form>
            {passwordResetStatus && <p className="auth-status">{passwordResetStatus}</p>}
            <button
              type="button"
              className="button-link"
              onClick={() => {
                setShowPasswordReset(false);
                setPasswordResetStatus(null);
                clearAuthEvent();
              }}
            >
              Avbryt
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="header-content">
            <div className="header-info">
              <h1>Lovdata Assistent</h1>
              <p>Logg inn med e-post for å chatte med norske juridiske data.</p>
            </div>
          </div>
        </header>
        <main className="app-main">
          <div className="auth-card">
            <h2>Logg inn</h2>
            <p>
              Velg hvordan du vil logge inn – enten magisk lenke eller passord (For eksisterende brukere).
            </p>
            <div className="auth-mode-toggle">
              <button
                type="button"
                className={authMode === 'magic' ? 'active' : ''}
                onClick={() => {
                  setAuthMode('magic');
                  setAuthStatus(null);
                }}
              >
                Magisk lenke
              </button>
              <button
                type="button"
                className={authMode === 'password' ? 'active' : ''}
                onClick={() => {
                  setAuthMode('password');
                  setAuthStatus(null);
                }}
              >
                Passord
              </button>
            </div>
            <form
              onSubmit={authMode === 'magic' ? handleMagicLinkLogin : handlePasswordLogin}
              className="auth-form"
            >
              <label htmlFor="auth-email">E-postadresse</label>
              <input
                id="auth-email"
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder="navn@example.com"
                required
              />
              {authMode === 'password' && (
                <>
                  <label htmlFor="auth-password">Passord</label>
                  <input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="********"
                    required
                  />
                  <button type="submit">Logg inn</button>
                  <button type="button" className="password-reset" onClick={handlePasswordReset}>
                    Glemt passord?
                  </button>
                </>
              )}
              {authMode === 'magic' && <button type="submit">Send innloggingslenke</button>}
            </form>
            {authStatus && <p className="auth-status">{authStatus}</p>}
          </div>
        </main>
      </div>
    );
  }

  // Show GDPR consent form if user is logged in but hasn't given consent
  if (session && hasGDPRConsent === false) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="header-content">
            <div className="header-info">
              <h1>Lovdata Assistent</h1>
              <p>Personvern og samtykke</p>
            </div>
          </div>
        </header>
        <main className="app-main scrollable">
          <GDPRConsentForm onSubmit={handleGDPRConsentSubmit} isLoading={savingConsent} />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <div className="header-info">
            <a
              className="header-title-link"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setActiveView('chat');
              }}
            >
              <h1>Lovdata Assistent</h1>
            </a>
            <p>Chat med norske juridiske data fra Lovdata.no</p>
          </div>
          <nav className="header-nav">
            <a
              className={`header-nav-link ${activeView === 'about' ? 'active' : ''}`}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setActiveView((prev) => (prev === 'about' ? 'chat' : 'about'));
              }}
            >
              Om Lovdata Assistent
            </a>
            <a
              className={`header-nav-link ${activeView === 'contact' ? 'active' : ''}`}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setActiveView((prev) => (prev === 'contact' ? 'chat' : 'contact'));
              }}
            >
              Kontakt oss
            </a>
            <span className="header-user">
              {session.user?.email ?? 'Innlogget bruker'}
              <button className="button-link" onClick={handleSignOut}>
                Logg ut
              </button>
            </span>
          </nav>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <p className="error-hint">
            {import.meta.env.PROD 
              ? 'Kunne ikke nå API-serveren. ' 
              : 'Sørg for at API-serveren kjører på http://localhost:4000 eller '}
            <button className="link-button" onClick={() => void checkHealth()}>
              prøv igjen nå
            </button>
            .
          </p>
        </div>
      )}

      <main className={`app-main ${activeView !== 'chat' ? 'scrollable' : ''}`}>
        {activeView === 'about' ? (
          <OmOss />
        ) : activeView === 'contact' ? (
          <KontaktOss />
        ) : (
          <ChatWindow
            messages={messages}
            isLoading={isLoading}
            inputSlot={
              <ChatInput
                onSend={handleSendMessage}
                disabled={isLoading}
                placeholder="Spør om norske juridiske data..."
              />
            }
          />
        )}
      </main>
      <footer className="app-footer">
        <p>
          Innlogget som {session.user?.email ?? 'ukjent bruker'}.{' '}
          {profile?.subscription
            ? `Abonnement: ${profile.subscription.status}`
            : 'Ingen aktivt abonnement registrert.'}
        </p>
      </footer>
      <Analytics />
    </div>
  );
}

export default App;
