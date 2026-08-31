-- CreateEnum
CREATE TYPE "VegMarker" AS ENUM ('veg', 'non_veg');

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "photo_url" TEXT,
ADD COLUMN     "name_hindi" TEXT,
ADD COLUMN     "veg_marker" "VegMarker";
