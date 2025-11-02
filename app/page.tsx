// app/page.tsx
export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 text-white grid place-items-center p-6">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-semibold">IMSEB – Client Review</h1>
        <p className="text-zinc-400">Use a URL like:</p>
        <code className="text-sm bg-white/10 px-2 py-1 rounded">
          /t/86c5w3c3p?title=Homepage%20V2&client=SpiderAds&preview=https://picsum.photos/1200
        </code>
      </div>
    </main>
  );
}
