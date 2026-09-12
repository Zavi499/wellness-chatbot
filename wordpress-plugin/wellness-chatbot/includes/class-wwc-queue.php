<?php
/**
 * Outbound push queue for product data.
 *
 * The old design POSTed to the backend synchronously from inside the
 * `woocommerce_update_product` hook, one full-data request per product. On
 * constrained hosting a bulk edit of hundreds of products meant hundreds of
 * outbound requests fired back-to-back, on top of whatever load the edit
 * itself already caused.
 *
 * Saving a product now only records its id here — no HTTP happens during the
 * save at all. WordPress's `shutdown` hook (after the response has already
 * gone to the browser) flushes a small queue as ONE batched request. A queue
 * larger than that is left for a WP-Cron job that drains it in chunks, so a
 * 500-product import collapses into a handful of requests instead of 500.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Queue {

	const OPTION           = 'wwc_push_queue';
	const CRON_HOOK         = 'wwc_drain_queue';
	const CRON_SCHEDULE     = 'wwc_five_minutes';
	/** A queue this size or smaller flushes immediately at the end of the request. */
	const SHUTDOWN_MAX      = 20;
	/** How many products a single outbound request carries. */
	const BATCH_SIZE        = 100;

	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'register_schedule' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval
		add_action( self::CRON_HOOK, array( __CLASS__, 'drain_via_cron' ) );
		add_action( 'shutdown', array( __CLASS__, 'maybe_flush_on_shutdown' ) );

		// Belt and braces: register_activation_hook() only fires when the plugin
		// is actually deactivated/reactivated through WordPress. A file-level
		// update (git deploy, FTP overwrite, a container rebuild) skips that
		// entirely, which silently leaves this cron job never scheduled — and
		// with it, any queue larger than SHUTDOWN_MAX permanently stuck with no
		// visible error. schedule_cron() is a no-op if it's already scheduled,
		// so checking on every load costs nothing and heals this automatically.
		self::schedule_cron();
	}

	/**
	 * Called on plugin activation. WP-Cron has no interval shorter than hourly
	 * built in, so this registers one.
	 *
	 * @param array $schedules Existing schedules.
	 * @return array
	 */
	public static function register_schedule( $schedules ) {
		$schedules[ self::CRON_SCHEDULE ] = array(
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => __( 'Every 5 minutes (Wellness Chatbot queue)', 'wellness-chatbot' ),
		);
		return $schedules;
	}

	public static function schedule_cron() {
		if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_event( time(), self::CRON_SCHEDULE, self::CRON_HOOK );
		}
	}

	public static function unschedule_cron() {
		wp_clear_scheduled_hook( self::CRON_HOOK );
	}

	/**
	 * How many product ids are currently waiting to be pushed — whether
	 * because the cron drain hasn't run yet, or (see init()'s comment) never
	 * got scheduled at all. Surfaced on the Settings screen so a stuck queue
	 * is visible instead of silently sitting there forever.
	 *
	 * @return int
	 */
	public static function queue_size() {
		return count( self::get_queue() );
	}

	/**
	 * Pushes the ENTIRE current queue right now, regardless of size, in
	 * batches of BATCH_SIZE — the manual "flush now" action for when an admin
	 * doesn't want to wait for the next cron firing (or is confirming the
	 * queue actually drains at all).
	 *
	 * @return int How many ids were queued before this call (0 = nothing to do).
	 */
	public static function flush_now() {
		$ids = self::get_queue();
		foreach ( array_chunk( $ids, self::BATCH_SIZE ) as $chunk ) {
			self::push_and_remove( $chunk, array( 'blocking' => true, 'timeout' => 30 ) );
		}
		return count( $ids );
	}

	/**
	 * Adds a product id to the queue. No HTTP happens here — this is a single
	 * option write, dwarfed by the cost of the product save itself.
	 *
	 * @param int $product_id Product ID.
	 */
	public static function enqueue( $product_id ) {
		$ids   = self::get_queue();
		$ids[] = (int) $product_id;
		self::save_queue( array_values( array_unique( $ids ) ) );
	}

	/**
	 * @return int[]
	 */
	private static function get_queue() {
		$ids = get_option( self::OPTION, array() );
		return is_array( $ids ) ? array_map( 'intval', $ids ) : array();
	}

	/**
	 * @param int[] $ids Product ids.
	 */
	private static function save_queue( array $ids ) {
		if ( false === get_option( self::OPTION, false ) ) {
			add_option( self::OPTION, $ids, '', false ); // autoload off — this option is never needed on a normal page load.
		} else {
			update_option( self::OPTION, $ids, false );
		}
	}

	/**
	 * Runs after the response has already been sent to the browser, so a
	 * customer or an editor saving a product never waits on this. A queue
	 * above SHUTDOWN_MAX is left for the cron job — flushing hundreds of
	 * products synchronously at shutdown would just move the same problem
	 * from "during the save" to "during the request that happened to be last".
	 */
	public static function maybe_flush_on_shutdown() {
		if ( ! WWC_Settings::is_connected() ) {
			return;
		}
		$ids = self::get_queue();
		if ( empty( $ids ) || count( $ids ) > self::SHUTDOWN_MAX ) {
			return;
		}
		// Non-blocking: this runs at the tail of a real request (an editor's
		// save, a customer's page load), and must never hold that connection
		// open waiting on the backend.
		self::push_and_remove( $ids, array( 'blocking' => false, 'timeout' => 5 ) );
	}

	/**
	 * Drains up to one batch per cron firing. Left-over ids stay queued for the
	 * next run, so a very large backlog spreads across several firings rather
	 * than one long-running request.
	 */
	public static function drain_via_cron() {
		if ( ! WWC_Settings::is_connected() ) {
			return;
		}
		$ids = array_slice( self::get_queue(), 0, self::BATCH_SIZE );
		if ( empty( $ids ) ) {
			return;
		}
		// Blocking: this runs as its own WP-Cron request, not tied to a visitor
		// waiting on a page — blocking here means a failure is visible in the
		// site's cron/error log instead of silently vanishing.
		self::push_and_remove( $ids, array( 'blocking' => true, 'timeout' => 30 ) );
	}

	/**
	 * Builds the payload for a set of ids, sends it as one batch, and removes
	 * only those ids from the queue — anything enqueued concurrently during the
	 * push stays for the next flush.
	 *
	 * @param int[] $ids  Product ids to push.
	 * @param array $args Request args — 'blocking' and 'timeout' (see WWC_Backend_Client::post()).
	 */
	private static function push_and_remove( array $ids, array $args ) {
		$products = array();
		foreach ( $ids as $id ) {
			$product = wc_get_product( $id );
			if ( ! $product ) {
				continue; // deleted since it was queued; nothing to push
			}
			if ( 'publish' !== $product->get_status() ) {
				// Left published status since it was queued — treat as a
				// deletion rather than pushing draft/private data.
				self::log_if_error(
					WWC_Backend_Client::post( WWC_Webhooks::ENDPOINT, array( 'action' => 'deleted', 'id' => $id ), $args )
				);
				continue;
			}
			$products[] = WWC_Product_Payload::build( $product );
		}

		if ( ! empty( $products ) ) {
			self::log_if_error(
				WWC_Backend_Client::post(
					WWC_Webhooks::ENDPOINT,
					array(
						'action'   => 'updated',
						'products' => $products,
						'relabel'  => WWC_Settings::relabel_on_save(),
					),
					$args
				)
			);
		}

		$remaining = array_values( array_diff( self::get_queue(), $ids ) );
		self::save_queue( $remaining );
	}

	/**
	 * @param array|WP_Error $response Backend response.
	 */
	private static function log_if_error( $response ) {
		if ( is_wp_error( $response ) ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			error_log( 'Wellness Chatbot push failed: ' . $response->get_error_message() );
		}
	}
}
