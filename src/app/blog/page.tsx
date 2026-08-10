import Link from 'next/link';
import { getCachedSortedPostsData } from '@/lib/posts';
import Footer from '@/components/Footer';

export default async function Blog() {
  const allPostsData = await getCachedSortedPostsData();

  return (
    <>
      <div className="min-h-screen bg-black text-white">
        <header className="py-12 border-b border-gray-800">
          <div className="container mx-auto px-4">
            <h1 className="text-5xl font-bold text-center">The ReloadSOL Blog</h1>
            <p className="text-xl text-center text-gray-400 mt-4">
              News, updates, and guides for the Solana ecosystem.
            </p>
          </div>
        </header>
        <main className="container mx-auto px-4 py-16">
          <div className="grid gap-12 max-w-4xl mx-auto">
            {allPostsData.map(({ id, date, title, excerpt }) => (
              <article key={id}>
                <h2 className="text-3xl font-bold mb-2">
                  <Link href={`/blog/${id}`} prefetch className="hover:text-indigo-400 transition-colors duration-200">
                    {title}
                  </Link>
                </h2>
                <p className="text-gray-400 mb-4">{new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                <p className="text-lg text-gray-300 leading-relaxed">{excerpt}</p>
                <Link href={`/blog/${id}`} prefetch className="text-indigo-400 hover:text-indigo-300 font-semibold mt-4 inline-block">
                  Read more &rarr;
                </Link>
              </article>
            ))}
          </div>
        </main>
      </div>
      <Footer />
    </>
  );
} 