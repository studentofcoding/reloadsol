import { getAllPostIds, getCachedPostData } from '@/lib/posts';
import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import Link from 'next/link';
import Footer from '@/components/Footer';

type Props = {
  params: Promise<{
    slug: string;
  }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const post = await getCachedPostData(slug);
    return {
      title: `${post.title} | ReloadSOL Blog`,
      description: `Read the latest post from the ReloadSOL team: ${post.title}`,
    };
  } catch (error) {
    return {
      title: 'Post Not Found | ReloadSOL Blog',
      description: 'This blog post could not be found.',
    };
  }
}

export function generateStaticParams() {
  const paths = getAllPostIds();
  return paths.map(p => ({ slug: p.params.slug }));
}

export default async function Post({ params }: Props) {
  const { slug } = await params;
  let post;
  try {
    post = await getCachedPostData(slug);
  } catch (error) {
    notFound();
  }

  return (
    <>
      <div className="bg-black text-white min-h-screen">
        <main className="container mx-auto px-4 py-16">
          <div className="max-w-3xl mx-auto">
            <div className="mb-8">
              <Link href="/blog" className="text-indigo-400 hover:text-indigo-300 transition-colors duration-200">
                &larr; Back to all posts
              </Link>
            </div>
            <article>
              <h1 className="text-4xl md:text-5xl font-bold mb-4">{post.title}</h1>
              <p className="text-gray-400 mb-8">
                {post.author} &bull; {new Date(post.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
              <div
                className="prose prose-invert prose-lg max-w-none prose-h2:font-bold prose-h2:text-2xl prose-h2:mt-8 prose-h2:mb-4 prose-p:leading-relaxed prose-a:text-indigo-400 hover:prose-a:text-indigo-300"
                dangerouslySetInnerHTML={{ __html: post.contentHtml }}
              />
            </article>
          </div>
        </main>
      </div>
      <Footer />
    </>
  );
}
