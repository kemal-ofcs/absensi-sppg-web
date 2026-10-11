import type { Metadata } from "next";
import { BRANDING } from "@/lib/constants/branding";
import { AuthProvider } from "@/lib/context/AuthContext";
import { ThemeProvider } from "@/lib/context/ThemeContext";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: BRANDING.appDisplayName,
    template: `%s · ${BRANDING.appDisplayName}`,
  },
  description: `${BRANDING.appDisplayName} management system for Web and Desktop with online and offline support.`,
  applicationName: BRANDING.appDisplayName,
};

const THEME_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem('sppg_theme');
    var isDark = stored === 'dark' || (!stored || stored === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: theme boot script prevents flash of unstyled content */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
