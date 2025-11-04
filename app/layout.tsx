// app/layout.tsx

export const metadata = {
  title: "Client Review",
  description: "Simple client review page",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-screen bg-zinc-950 text-white">{children}</body>
    </html>
  );
}
