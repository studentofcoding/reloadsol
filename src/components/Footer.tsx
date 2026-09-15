'use client'

import React from 'react'
import Link from 'next/link';

const DISCORD_URL = 'https://discord.gg/Z8fUwVJHjp'

export default function Footer() {
  return (
    <footer aria-label="Site" className="bg-black border-t border-gray-800 py-8 mt-16">
      <div className="container mx-auto px-4">
        <div className="flex justify-center items-center space-x-6 mb-4">
          <Link href="/" className="text-gray-300 hover:text-white transition-colors duration-200">
            Home
          </Link>
          <Link href="/blog" className="text-gray-300 hover:text-white transition-colors duration-200">
            Blog
          </Link>
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-300 hover:text-white transition-colors duration-200"
          >
            Discord
          </a>
        </div>
        <div className="text-center">
          <p className="text-gray-400 text-sm leading-relaxed">
            Created with love by{' '}
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-300 hover:text-white transition-colors duration-200 underline decoration-gray-600 hover:decoration-white"
            >
              @reload_sol
            </a>{' '}
            team
          </p>
          <p className="text-gray-400 text-sm mt-2">
            Kindly join our{' '}
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 transition-colors duration-200 underline decoration-indigo-600 hover:decoration-indigo-300"
            >
              Discord
            </a>{' '}
            for any question, bug reports, or collaboration
          </p>
          <p className="text-gray-400 text-sm mt-2">
            Happy degening! 🚀
          </p>
        </div>
      </div>
    </footer>
  )
}
