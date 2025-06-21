'use client'

import React from 'react'

export default function Footer() {
  const handleDiscordClick = () => {
    // You can replace this with the actual Discord invite link
    window.open('https://discord.gg/your-discord-server', '_blank')
  }

  return (
    <footer className="bg-black border-t border-gray-800 py-8 mt-16">
      <div className="container mx-auto px-4">
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
            Kindly join our discord for any question, or collaboration
          </p>
          <p className="text-gray-400 text-sm mt-2">
            Happy degening! 🚀
          </p>
        </div>
      </div>
    </footer>
  )
} 