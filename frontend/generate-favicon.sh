#!/bin/bash

# Script to generate favicon.ico from SVG
# This script requires imagemagick (brew install imagemagick)

echo "🎨 Generating QuantAI favicon from SVG..."

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
    echo "❌ ImageMagick not found. Please install it:"
    echo "   macOS: brew install imagemagick"
    echo "   Ubuntu: sudo apt-get install imagemagick"
    exit 1
fi

# Navigate to the public directory
cd "$(dirname "$0")/public" || exit

# Generate PNG from SVG (needed for ICO conversion)
echo "📱 Converting SVG to PNG..."
convert favicon.svg -resize 32x32 favicon-32.png
convert favicon.svg -resize 16x16 favicon-16.png

# Generate ICO file with multiple sizes
echo "🔧 Creating ICO file..."
convert favicon-16.png favicon-32.png favicon.ico

# Generate additional PNG sizes for different devices
echo "📐 Creating additional PNG sizes..."
convert favicon.svg -resize 16x16 favicon-16x16.png
convert favicon.svg -resize 32x32 favicon-32x32.png
convert favicon-48.svg -resize 48x48 favicon-48x48.png
convert apple-touch-icon.svg -resize 180x180 apple-touch-icon-180x180.png

# Cleanup temporary files
rm favicon-16.png favicon-32.png

echo "✅ Favicon generation complete!"
echo "   Generated files:"
echo "   - favicon.ico (multi-size)"
echo "   - favicon-16x16.png"
echo "   - favicon-32x32.png" 
echo "   - favicon-48x48.png"
echo "   - apple-touch-icon-180x180.png"