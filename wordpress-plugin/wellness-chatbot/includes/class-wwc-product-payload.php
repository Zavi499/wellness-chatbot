<?php
/**
 * Converts a loaded `WC_Product` into the shape the backend's normalizer
 * expects (`WooRawProduct` in `backend/src/products/normalize.ts`).
 *
 * Every value here comes off the product object the caller already loaded, or
 * its already-cached taxonomy terms — this never triggers an extra product
 * load. It is the one place that shape is built, used by both the save queue
 * (`WWC_Queue`) and the bulk exporter (`WWC_Exporter`), so the two paths can
 * never drift apart.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Product_Payload {

	/**
	 * @param WC_Product $product Product — may be either the canonical
	 *                            (English) post or one of its WPML
	 *                            translations; either way the payload built
	 *                            is always keyed by, and built from, the
	 *                            canonical post.
	 * @return array
	 */
	public static function build( WC_Product $product ) {
		$canonical_id = WWC_Wpml::canonical_id( $product->get_id() );
		if ( $canonical_id !== $product->get_id() ) {
			$canonical = wc_get_product( $canonical_id );
			if ( $canonical instanceof WC_Product ) {
				$product = $canonical;
			}
		}

		$name_ar        = null;
		$description_ar = null;
		$short_ar       = null;
		$ar_id          = WWC_Wpml::translation_id( $canonical_id, 'ar' );
		if ( $ar_id ) {
			$ar_product = wc_get_product( $ar_id );
			if ( $ar_product instanceof WC_Product ) {
				$name_ar        = $ar_product->get_name();
				$description_ar = (string) $ar_product->get_description();
				$short_ar       = (string) $ar_product->get_short_description();
			}
		}

		return array(
			'id'                   => $canonical_id,
			'name'                 => $product->get_name(),
			'name_ar'              => $name_ar,
			'sku'                  => (string) $product->get_sku(),
			'permalink'            => $product->get_permalink(),
			'status'               => $product->get_status(),
			'catalog_visibility'   => $product->get_catalog_visibility(),
			'description'          => (string) $product->get_description(),
			'description_ar'       => $description_ar,
			'short_description'    => (string) $product->get_short_description(),
			'short_description_ar' => $short_ar,
			'price'                => (string) $product->get_price(),
			'regular_price'        => (string) $product->get_regular_price(),
			'sale_price'           => (string) $product->get_sale_price(),
			'stock_status'         => $product->get_stock_status(),
			'average_rating'       => (string) $product->get_average_rating(),
			'rating_count'         => (int) $product->get_rating_count(),
			'categories'           => self::terms( $product, 'product_cat' ),
			'tags'                 => self::terms( $product, 'product_tag' ),
			'images'               => self::images( $product ),
			'attributes'           => self::attributes( $product ),
		);
	}

	/**
	 * @param WC_Product $product  Product.
	 * @param string     $taxonomy Taxonomy slug.
	 * @return array<int,array{id:int,name:string,slug:string}>
	 */
	private static function terms( WC_Product $product, $taxonomy ) {
		$terms = get_the_terms( $product->get_id(), $taxonomy );
		if ( ! is_array( $terms ) ) {
			return array();
		}
		return array_values(
			array_map(
				function ( $term ) {
					return array(
						'id'   => (int) $term->term_id,
						'name' => $term->name,
						'slug' => $term->slug,
					);
				},
				$terms
			)
		);
	}

	/**
	 * @param WC_Product $product Product.
	 * @return array<int,array{src:string}>
	 */
	private static function images( WC_Product $product ) {
		$ids = array_filter( array_merge( array( $product->get_image_id() ), $product->get_gallery_image_ids() ) );
		$out = array();
		foreach ( $ids as $id ) {
			$src = wp_get_attachment_image_url( $id, 'full' );
			if ( $src ) {
				$out[] = array( 'src' => $src );
			}
		}
		return $out;
	}

	/**
	 * @param WC_Product $product Product.
	 * @return array<int,array{name:string,options:string[]}>
	 */
	private static function attributes( WC_Product $product ) {
		$out = array();

		foreach ( $product->get_attributes() as $attribute ) {
			if ( ! $attribute instanceof WC_Product_Attribute ) {
				continue;
			}

			if ( $attribute->is_taxonomy() ) {
				$name    = wc_attribute_label( $attribute->get_name() );
				$options = wc_get_product_terms(
					$product->get_id(),
					$attribute->get_name(),
					array( 'fields' => 'names' )
				);
			} else {
				$name    = $attribute->get_name();
				$options = $attribute->get_options();
			}

			$out[] = array(
				'name'    => (string) $name,
				'options' => array_values( array_filter( array_map( 'strval', (array) $options ) ) ),
			);
		}

		return $out;
	}
}
