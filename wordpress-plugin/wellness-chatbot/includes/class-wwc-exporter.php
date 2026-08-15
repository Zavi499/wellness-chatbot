<?php
/**
 * Bulk catalogue export — the replacement for the backend pulling products
 * over the WooCommerce REST API.
 *
 * `wc_get_products()` is WordPress's own query layer, the same thing the
 * admin product list uses — not the REST API, so this carries none of the
 * per-request authentication/JSON overhead a REST pull did. Walking a few
 * hundred products this way is comparable in cost to loading the admin
 * product list once, not to hundreds of API calls.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Exporter {

	const BATCH_SIZE = 100;

	/**
	 * Writes the whole published catalogue to one JSON file.
	 *
	 * @param string $destination Absolute file path to write.
	 * @return int|WP_Error The number of products written, or an error.
	 */
	public static function export_to_file( $destination ) {
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 180 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.PHP.DiscouragedPHPFunctions.runtime_configuration_set_time_limit
		}

		$products = self::collect();

		$json = wp_json_encode(
			array(
				'exported_at' => current_time( 'mysql' ),
				'count'       => count( $products ),
				'products'    => $products,
			),
			JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
		);

		if ( false === $json ) {
			return new WP_Error( 'wwc_export_encode_failed', __( 'Could not encode the catalogue as JSON.', 'wellness-chatbot' ) );
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		$written = file_put_contents( $destination, $json );
		if ( false === $written ) {
			return new WP_Error(
				'wwc_export_write_failed',
				sprintf( /* translators: %s: file path. */ __( 'Could not write the export to %s. Check the uploads directory is writable.', 'wellness-chatbot' ), $destination )
			);
		}

		return count( $products );
	}

	/**
	 * @return array Every published product, in the shape the backend expects.
	 */
	public static function collect() {
		$products = array();
		$page     = 1;

		do {
			$batch = wc_get_products(
				array(
					'status'  => 'publish',
					'limit'   => self::BATCH_SIZE,
					'page'    => $page,
					'orderby' => 'ID',
					'order'   => 'ASC',
					'return'  => 'objects',
				)
			);

			foreach ( $batch as $product ) {
				if ( $product instanceof WC_Product ) {
					$products[] = WWC_Product_Payload::build( $product );
				}
			}

			++$page;
		} while ( count( $batch ) === self::BATCH_SIZE );

		return $products;
	}

	/**
	 * The directory exports are written to. Created on first use, with an
	 * index.php so directory listings never expose an export file by name
	 * guessing on a misconfigured host.
	 *
	 * @return string
	 */
	public static function export_dir() {
		$upload = wp_upload_dir();
		$dir    = trailingslashit( $upload['basedir'] ) . 'wellness-chatbot';

		if ( ! file_exists( $dir ) ) {
			wp_mkdir_p( $dir );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
			file_put_contents( $dir . '/index.php', "<?php\n// Silence is golden.\n" );
		}

		return $dir;
	}

	/**
	 * @return string A timestamped filename, so repeat exports don't collide.
	 */
	public static function default_filename() {
		return 'catalogue-' . gmdate( 'Y-m-d-His' ) . '.json';
	}
}
