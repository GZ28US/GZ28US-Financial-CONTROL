// Public landing page shown at the bare domain root (www.gz28us.com). The app
// itself lives under /fcs, so the root resolves here. The auth gate lets this
// through (see components/AuthGate.tsx).

const RED = '#FF0000'

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 justify-center">
      <span className="shrink-0 w-7 h-7 text-white">{icon}</span>
      <span className="text-white text-lg sm:text-xl font-bold">{children}</span>
    </div>
  )
}

const linkClass = 'underline decoration-white/40 hover:decoration-white'

export default function NotFound() {
  return (
    <main
      className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-12 text-center"
      style={{ backgroundColor: RED }}
    >
      <p className="text-white text-2xl sm:text-3xl font-extrabold uppercase tracking-[0.25em] mb-8">
        Website under build
      </p>

      <img
        src="/fcs/logo_gz28.jpg"
        alt="GZ28 V8 SpeedShop"
        className="w-full max-w-3xl h-auto mb-12"
      />

      <div className="flex flex-col gap-4">
        <Row icon={<IconPin />}>
          <a className={linkClass} target="_blank" rel="noopener noreferrer" href="https://maps.google.com/?q=11320+Space+Blvd+Orlando+FL+32837">
            11320 Space Blvd, Orlando/FL, 32837
          </a>
        </Row>
        <Row icon={<IconPhone />}>
          <a className={linkClass} href="tel:+13213150973">(321) 315.0973</a>
        </Row>
        <Row icon={<IconWhatsApp />}>
          <a className={linkClass} target="_blank" rel="noopener noreferrer" href="https://wa.me/13213150973">(321) 315.0973</a>
        </Row>
        <Row icon={<IconMail />}>
          <a className={linkClass} href="mailto:gz28us@hotmail.com">gz28us@hotmail.com</a>
        </Row>
        <Row icon={<IconInstagram />}>
          <a className={linkClass} target="_blank" rel="noopener noreferrer" href="https://instagram.com/gz28us">@gz28us</a>
          {' / '}
          <a className={linkClass} target="_blank" rel="noopener noreferrer" href="https://instagram.com/gz28br">@gz28br</a>
        </Row>
        <Row icon={<IconFacebook />}>
          <a className={linkClass} target="_blank" rel="noopener noreferrer" href="https://www.facebook.com/gz28us">facebook.com/gz28us</a>
        </Row>
      </div>
    </main>
  )
}

/* ---- icons (inline SVG, white) ---- */
function IconPin() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
    </svg>
  )
}
function IconPhone() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.05-.24 11.36 11.36 0 003.56.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.56 1 1 0 01-.24 1.05l-2.2 2.18z" />
    </svg>
  )
}
function IconWhatsApp() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.945C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 018.413 3.488 11.82 11.82 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 001.51 5.26l-.999 3.648 3.978-1.715zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
    </svg>
  )
}
function IconMail() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
    </svg>
  )
}
function IconInstagram() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.43.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.43.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 01-1.38-.9 3.7 3.7 0 01-.9-1.38c-.16-.43-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.43-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.68a6.16 6.16 0 100 12.32 6.16 6.16 0 000-12.32zm0 10.16a4 4 0 110-8 4 4 0 010 8zm6.41-10.4a1.44 1.44 0 11-2.88 0 1.44 1.44 0 012.88 0z" />
    </svg>
  )
}
function IconFacebook() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full">
      <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
    </svg>
  )
}
