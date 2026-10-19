# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Bill row locking under concurrency (#227): acquire `lockBill` row lock inside transaction for `confirmIntent`, `payShare`, and `payAll` to serialize concurrent payments, prevent duplicate tenders, and avoid unfinalizable tender mismatch states.
- Guest QR bill payment now sends any unsent staff-added lines to the kitchen through the shared finalize transaction. POS finalize uses the same hook once; already-ticketed lines are skipped, and rejected settlement creates no tickets (#228).
