# Fix for Database Constraint Violation and Unhandled Promise Rejection

> **Note (Jul 2026):** Production DB is Postgres `reloadsol_db` (Docker). Supabase is no longer used. Apply fixes via `docker exec reloadsol-db psql -U reloadsol -d reloadsol_db`.

## Issues Fixed

### 1. Database Constraint Violation (Error Code 23514)
**Problem**: The code was trying to insert tokens with status 'waiting', but the database constraint only allowed 'tracking', 'won', or 'lost'.

**Error Message**:
```
new row for relation "trending_token_tracker" violates check constraint "trending_token_tracker_status_check"
```

### 2. Unhandled Promise Rejection
**Problem**: Database errors were being thrown in async functions within Promise arrays, causing unhandled rejections.

**Error Message**:
```
You have triggered an unhandledRejection, you may have forgotten to catch a Promise rejection
```

## Solutions Applied

### 1. Database Schema Update
**File**: `scripts/fix-status-constraint.sql`

This SQL script:
- Drops the existing check constraint
- Creates a new constraint that includes 'waiting' and 'skipped' statuses
- Adds missing columns for the waiting system
- Creates performance indexes

**To Apply**: Run via psql on `reloadsol_db`:

```bash
docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db < scripts/fix-status-constraint.sql
```

Or paste contents of `scripts/fix-status-constraint.sql` in an interactive psql session.

### 2. Code Error Handling Improvements
**File**: `src/app/api/trending/track/route.ts`

Changes made:
- Modified async functions in `updatesPromises` to return success/error objects instead of throwing
- Updated Promise.allSettled handling to properly track both rejected promises and failed operations
- Enhanced error logging with detailed failure information

## Verification

After applying these fixes:

1. **Database Constraint**: Tokens with 'waiting' status should insert successfully
2. **Promise Handling**: No more unhandled rejection errors in logs
3. **Error Reporting**: Better visibility into which specific operations failed

## Status Values Now Supported

The database now supports these status values:
- `'tracking'` - Currently monitoring price movements
- `'won'` - Top performers marked during summary
- `'lost'` - Dropped >50% from initial price
- `'waiting'` - Tokens waiting for a price dip before tracking
- `'skipped'` - Tokens that were skipped for various reasons

## Additional Improvements

- Added indexes for better query performance
- Enhanced error logging with token symbols and error details
- Proper handling of both synchronous and asynchronous failures
- Maintained backward compatibility with existing data

## Testing

To test the fixes:
1. Run the SQL migration via psql (see above)
2. Deploy the updated code
3. Monitor logs for the absence of constraint violation errors
4. Verify that tokens with 'waiting' status are being inserted successfully