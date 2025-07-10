'use client'

import React from 'react'
import Link from 'next/link';

export default function Footer() {
  const handleDiscordClick = () => {
    window.open('https://discord.gg/Z8fUwVJHjp', '_blank')
  }

  return (
    <footer className="bg-black border-t border-gray-800 py-8 mt-16">
      <div className="container mx-auto px-4">
        <div className="flex justify-center items-center space-x-6 mb-4">
          <Link href="/" className="text-gray-300 hover:text-white transition-colors duration-200">
            Home
          </Link>
          <Link href="/blog" className="text-gray-300 hover:text-white transition-colors duration-200">
            Blog
          </Link>
          <button
            onClick={handleDiscordClick}
            className="text-gray-300 hover:text-white transition-colors duration-200"
          >
            Discord
          </button>
        </div>
        <div className="text-center">
          <p className="text-gray-400 text-sm leading-relaxed">
            Created with love by{' '}
            <button
              onClick={handleDiscordClick}
              className="text-gray-300 hover:text-white transition-colors duration-200 underline decoration-gray-600 hover:decoration-white"
            >
              @reload_sol
            </button>{' '}
            team
          </p>
          <p className="text-gray-400 text-sm mt-2">
            Kindly join our{' '}
            <button
              onClick={handleDiscordClick}
              className="text-indigo-400 hover:text-indigo-300 transition-colors duration-200 underline decoration-indigo-600 hover:decoration-indigo-300"
            >
              Discord
            </button>{' '}
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