<?php
/**
 * `wp wellness-chatbot export` — generates the catalogue export file from the
 * command line, spending no web-server request budget at all.
 *
 * This file is only ever `require`d when WP-CLI is actually running (see the
 * guarded registration in wellness-chatbot.php) — referencing
 * `WP_CLI_Command` as a parent class during a normal page load, where it does
 * not exist, would fatal at class-declaration time, not lazily.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_CLI extends WP_CLI_Command {

	/**
	 * Exports the published catalogue to a JSON file for the chatbot backend.
	 *
	 * ## OPTIONS
	 *
	 * [--file=<path>]
	 * : Where to write the export. Defaults to a timestamped file in the
	 * plugin's uploads directory.
	 *
	 * ## EXAMPLES
	 *
	 *     wp wellness-chatbot export
	 *     wp wellness-chatbot export --file=/tmp/catalogue.json
	 *
	 * @param array $args       Positional args (unused).
	 * @param array $assoc_args Named args.
	 */
	public function export( $args, $assoc_args ) {
		unset( $args );

		$file = isset( $assoc_args['file'] )
			? $assoc_args['file']
			: trailingslashit( WWC_Exporter::export_dir() ) . WWC_Exporter::default_filename();

		WP_CLI::log( 'Collecting published products…' );
		$result = WWC_Exporter::export_to_file( $file );

		if ( is_wp_error( $result ) ) {
			WP_CLI::error( $result->get_error_message() );
			return;
		}

		WP_CLI::success( sprintf( 'Wrote %d products to %s', $result, $file ) );
		WP_CLI::log( 'Copy this file to the backend server, then run: npm run import:prod -- --file <path> --embed' );
	}
}
