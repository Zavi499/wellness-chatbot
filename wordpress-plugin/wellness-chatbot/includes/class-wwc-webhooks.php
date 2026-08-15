<?php
/**
 * WooCommerce product change notifications (spec §1.2, §10).
 *
 * Saving a product enqueues its id (WWC_Queue) rather than pushing
 * immediately — no HTTP happens during the save itself. The queue flushes as
 * one batched request at the end of the request, or via cron for a large
 * backlog. Stock changes and deletions stay immediate: they carry no product
 * data, so a single small push costs almost nothing.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Webhooks {

	const ENDPOINT = '/api/webhooks/woocommerce/product';

	public static function init() {
		add_action( 'woocommerce_update_product', array( __CLASS__, 'on_product_saved' ), 20, 1 );
		add_action( 'woocommerce_new_product', array( __CLASS__, 'on_product_saved' ), 20, 1 );
		add_action( 'woocommerce_product_set_stock_status', array( __CLASS__, 'on_stock_status' ), 20, 3 );
		add_action( 'woocommerce_variation_set_stock_status', array( __CLASS__, 'on_stock_status' ), 20, 3 );
		add_action( 'before_delete_post', array( __CLASS__, 'on_product_deleted' ), 10, 2 );
		add_action( 'wp_trash_post', array( __CLASS__, 'on_product_trashed' ), 10, 1 );
	}

	/**
	 * @param int $product_id Product ID.
	 */
	public static function on_product_saved( $product_id ) {
		if ( ! WWC_Settings::is_connected() ) {
			return;
		}

		$product = wc_get_product( $product_id );
		if ( ! $product ) {
			return;
		}

		// Guard against the double-fire WooCommerce does on some save paths.
		$fingerprint = md5( (string) $product->get_date_modified() . $product->get_price() . $product->get_stock_status() );
		if ( get_transient( 'wwc_sync_' . $product_id ) === $fingerprint ) {
			return;
		}
		set_transient( 'wwc_sync_' . $product_id, $fingerprint, 60 );

		if ( 'publish' !== $product->get_status() ) {
			// A draft/private/pending product has nothing to recommend — if it
			// was previously live, tell the backend to stop showing it. This is
			// cheap (no product data) so it stays an immediate push.
			WWC_Backend_Client::notify( self::ENDPOINT, array( 'action' => 'deleted', 'id' => $product_id ) );
			return;
		}

		// Full data is queued, not pushed here — see WWC_Queue. This is what
		// turns a bulk edit of hundreds of products into a handful of requests
		// instead of one per product.
		WWC_Queue::enqueue( $product_id );
	}

	/**
	 * @param int    $product_id Product ID.
	 * @param string $status     New stock status.
	 * @param mixed  $product    Product object.
	 */
	public static function on_stock_status( $product_id, $status, $product = null ) {
		unset( $product );
		if ( ! WWC_Settings::is_connected() ) {
			return;
		}

		WWC_Backend_Client::notify(
			self::ENDPOINT,
			array(
				'action'       => 'stock_changed',
				'id'           => (int) $product_id,
				'stock_status' => sanitize_key( (string) $status ),
			)
		);
	}

	/**
	 * @param int     $post_id Post ID.
	 * @param WP_Post $post    Post object.
	 */
	public static function on_product_deleted( $post_id, $post = null ) {
		if ( ! WWC_Settings::is_connected() ) {
			return;
		}
		$type = $post instanceof WP_Post ? $post->post_type : get_post_type( $post_id );
		if ( 'product' !== $type ) {
			return;
		}

		WWC_Backend_Client::notify( self::ENDPOINT, array( 'action' => 'deleted', 'id' => (int) $post_id ) );
	}

	/**
	 * A trashed product must stop being recommended immediately.
	 *
	 * @param int $post_id Post ID.
	 */
	public static function on_product_trashed( $post_id ) {
		if ( 'product' !== get_post_type( $post_id ) ) {
			return;
		}
		self::on_product_deleted( $post_id );
	}
}
