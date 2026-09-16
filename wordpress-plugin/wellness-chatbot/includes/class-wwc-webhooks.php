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
	 * @param int $product_id Product ID — may be a WPML translation's post
	 *                        id, in which case this operates on its
	 *                        canonical (English) sibling instead, so editing
	 *                        either language ends up pushing the same
	 *                        product.
	 */
	public static function on_product_saved( $product_id ) {
		if ( ! WWC_Settings::is_connected() ) {
			return;
		}

		$product_id = WWC_Wpml::canonical_id( $product_id );
		$product    = wc_get_product( $product_id );
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

		$product_id = WWC_Wpml::canonical_id( $product_id );

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
	 * @param int     $post_id Post ID — the WPML translation's id if a
	 *                         translation (not the original) is what's being
	 *                         removed.
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

		if ( ! WWC_Wpml::is_canonical( $post_id ) ) {
			// Only a translation (e.g. the Arabic post) is being removed —
			// the product itself still exists. Re-sync the canonical product
			// so the next flush drops the now-gone translation text, rather
			// than deleting the whole product from the backend.
			WWC_Queue::enqueue( WWC_Wpml::canonical_id( $post_id ) );
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
